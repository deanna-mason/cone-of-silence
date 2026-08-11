// PeerLink screen-share senders: the screen track must enter through the same
// addLocalTrack funnel as every other track (E2EE encrypt transform + VP9 pin,
// or the far side gets frames it can't decrypt/packetize) — but the sender it
// lands on belongs to the SCREEN, not to the device-switch machinery:
// replaceStream must never swap a camera onto it, never count it as covering
// "video", and never try to re-populate it after a stop cleared it. Same
// fake-platform idiom as peer-dead-track.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerLink } from "@/lib/webrtc/peer";

type Track = { kind: string; readyState: string };

class FakeSender {
  transform: unknown = null;
  replaceTrack = vi.fn(async (track: Track | null) => {
    this.track = track;
  });
  createEncodedStreams = vi.fn(() => ({ readable: {} as ReadableStream, writable: {} as WritableStream }));
  constructor(public track: Track | null) {}
}
class FakeTransceiver {
  setCodecPreferences = vi.fn();
  receiver = { track: null };
  constructor(public sender: FakeSender) {}
}
class SenderPC {
  static lastInstance: SenderPC | undefined;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  senders: FakeSender[] = [];
  transceivers: FakeTransceiver[] = [];
  restartIce = vi.fn();
  localDescription = null;
  setLocalDescription = vi.fn(async () => {});
  addTrack = vi.fn((track: Track) => {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    this.transceivers.push(new FakeTransceiver(sender));
    return sender as unknown as RTCRtpSender;
  });
  createDataChannel() {
    return { onopen: null } as unknown as RTCDataChannel;
  }
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return this.transceivers;
  }
  close() {}
  constructor() {
    SenderPC.lastInstance = this;
  }
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onerror: unknown = null;
  onmessageerror: unknown = null;
  onmessage: unknown = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
}

const noop = () => {};
const live = (kind: string): Track => ({ kind, readyState: "live" });
const ended = (kind: string): Track => ({ kind, readyState: "ended" });
const streamOf = (tracks: Track[]): MediaStream => ({ getTracks: () => tracks }) as unknown as MediaStream;
const vp9Caps = {
  codecs: [{ mimeType: "video/VP9" }, { mimeType: "video/rtx" }],
  headerExtensions: [],
} as unknown as RTCRtpCapabilities;

function buildLink(localStream: MediaStream, e2ee?: { mediaKey: CryptoKey; api: "encoded-streams" }) {
  vi.stubGlobal("RTCPeerConnection", SenderPC);
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  const link = new PeerLink({ polite: true, localStream, sendSignal: noop, onRemoteStream: noop, ...(e2ee ? { e2ee } : {}) });
  return { link, pc: SenderPC.lastInstance! };
}

const screenTrack = () => live("video");
const screenStreamOf = (track: Track) => streamOf([track]);

describe("startScreenShare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds the screen track as a new sender with the screen's own stream", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    pc.addTrack.mockClear();
    const track = screenTrack();
    const stream = screenStreamOf(track);

    await link.startScreenShare(track as unknown as MediaStreamTrack, stream);

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack).toHaveBeenCalledWith(track, stream);
  });

  it("routes through the E2EE funnel: encrypt transform + VP9 pin on the screen sender", async () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    const { link, pc } = buildLink(streamOf([live("audio")]), { mediaKey: {} as CryptoKey, api: "encoded-streams" });
    const worker = FakeWorker.instances[0];
    worker.postMessage.mockClear();
    const track = screenTrack();

    await link.startScreenShare(track as unknown as MediaStreamTrack, screenStreamOf(track));

    const screenSender = pc.senders[pc.senders.length - 1];
    expect(screenSender.createEncodedStreams).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ op: "pipe", side: "encrypt" }),
      expect.anything(),
    );
    const transceiver = pc.transceivers.find((t) => t.sender === screenSender)!;
    expect(transceiver.setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: "video/VP9" },
      { mimeType: "video/rtx" },
    ]);
  });

  it("re-arms the existing screen sender on a second share instead of adding another", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const first = screenTrack();
    await link.startScreenShare(first as unknown as MediaStreamTrack, screenStreamOf(first));
    const screenSender = pc.senders[pc.senders.length - 1];
    pc.addTrack.mockClear();

    const second = screenTrack();
    await link.startScreenShare(second as unknown as MediaStreamTrack, screenStreamOf(second));

    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(screenSender.replaceTrack).toHaveBeenLastCalledWith(second);
  });
});

describe("stopScreenShare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears the screen sender's track (no teardown, no renegotiation)", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const track = screenTrack();
    await link.startScreenShare(track as unknown as MediaStreamTrack, screenStreamOf(track));
    const screenSender = pc.senders[pc.senders.length - 1];

    await link.stopScreenShare();

    expect(screenSender.replaceTrack).toHaveBeenLastCalledWith(null);
  });
});

describe("replaceStream never touches the screen sender", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a device switch swaps the camera sender and leaves the live screen sender alone", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const cameraSender = pc.senders[1];
    const track = screenTrack();
    await link.startScreenShare(track as unknown as MediaStreamTrack, screenStreamOf(track));
    const screenSender = pc.senders[pc.senders.length - 1];
    pc.addTrack.mockClear();

    const nextCamera = live("video");
    await link.replaceStream(streamOf([live("audio"), nextCamera]));

    expect(screenSender.replaceTrack).not.toHaveBeenCalled();
    expect(cameraSender.replaceTrack).toHaveBeenLastCalledWith(nextCamera);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("the screen sender does not count as covering 'video' — a re-plugged camera still gets its own sender", async () => {
    // Built with the camera unplugged: audio sender only.
    const { link, pc } = buildLink(streamOf([live("audio"), ended("video")]));
    const track = screenTrack();
    await link.startScreenShare(track as unknown as MediaStreamTrack, screenStreamOf(track));
    const screenSender = pc.senders[pc.senders.length - 1];
    pc.addTrack.mockClear();

    const camera = live("video");
    await link.replaceStream(streamOf([live("audio"), camera]));

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack.mock.calls[0][0]).toBe(camera);
    expect(screenSender.replaceTrack).not.toHaveBeenCalled();
  });

  it("a STOPPED screen sender is not re-populated by a later device switch", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const cameraSender = pc.senders[1];
    const track = screenTrack();
    await link.startScreenShare(track as unknown as MediaStreamTrack, screenStreamOf(track));
    const screenSender = pc.senders[pc.senders.length - 1];
    await link.stopScreenShare();
    screenSender.replaceTrack.mockClear();
    pc.addTrack.mockClear();

    const nextCamera = live("video");
    await link.replaceStream(streamOf([live("audio"), nextCamera]));

    expect(screenSender.replaceTrack).not.toHaveBeenCalled(); // null-track + kind "video", still not a camera slot
    expect(cameraSender.replaceTrack).toHaveBeenLastCalledWith(nextCamera);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });
});
