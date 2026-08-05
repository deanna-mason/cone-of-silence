// 8/5 drill defect: after a camera unplug, the local stream keeps an ENDED
// video track. A rebuilt PeerLink must not hand that track to the pc — the
// dead sender's m-line/transform/codec-pin path can throw and destroy the
// whole link, audio included (the one-way-audio incident). And a failed
// negotiation must surface as connectionState "failed" so the mesh's
// restart/rebuild ladder engages instead of wedging in "connecting".
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerLink } from "@/lib/webrtc/peer";

function makeFakePC(overrides: Partial<Record<string, unknown>> = {}) {
  class FakePC {
    static lastInstance: InstanceType<typeof FakePC> | undefined;
    onnegotiationneeded: (() => Promise<void>) | null = null;
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    // addTrack RETURNS the sender it created — core WebRTC, not a 5D
    // extension — and PeerLink now records that sender's kind so a sender
    // whose track later goes null is still re-populatable. The fake has to
    // honor that contract; the assertions below are unchanged.
    addTrack = vi.fn((track: MediaStreamTrack) => ({ track }) as unknown as RTCRtpSender);
    restartIce = vi.fn();
    localDescription = null;
    setLocalDescription = vi.fn(async () => {});
    createDataChannel() {
      return { onopen: null } as unknown as RTCDataChannel;
    }
    getSenders() {
      return [];
    }
    close() {}
    constructor() {
      Object.assign(this, overrides);
      FakePC.lastInstance = this;
    }
  }
  vi.stubGlobal("RTCPeerConnection", FakePC);
  return FakePC;
}

const noop = () => {};

function streamWith(tracks: Array<{ kind: string; readyState: string }>): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

describe("PeerLink with a dead local track", () => {
  it("skips an ended video track but still adds the live audio track", () => {
    const FakePC = makeFakePC();
    const audio = { kind: "audio", readyState: "live" };
    const video = { kind: "video", readyState: "ended" };
    new PeerLink({
      polite: true,
      localStream: streamWith([audio, video]),
      sendSignal: noop,
      onRemoteStream: noop,
    });
    const pc = FakePC.lastInstance!;
    expect(pc.addTrack).toHaveBeenCalledTimes(1);
    expect(pc.addTrack.mock.calls[0][0]).toBe(audio);
    vi.unstubAllGlobals();
  });

  it("reports a failed negotiation as connectionState 'failed' (never a silent wedge)", async () => {
    const FakePC = makeFakePC({
      setLocalDescription: vi.fn(async () => {
        throw new Error("sLD refused");
      }),
    });
    const onConnectionState = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    new PeerLink({
      polite: true,
      localStream: streamWith([]),
      sendSignal: noop,
      onRemoteStream: noop,
      onConnectionState,
    });
    const pc = FakePC.lastInstance!;
    await pc.onnegotiationneeded!();
    expect(onConnectionState).toHaveBeenCalledWith("failed");
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// 8/5 re-drill finding 3: the OTHER half of the same incident. Skipping the
// ended track at construction (above) means a link built while the camera was
// unplugged has NO video sender at all — and replaceStream only ever swapped
// tracks on senders that already existed, so no later camera pick could ever
// reach the peer. Same fake-platform idiom, one rung richer: this FakePC
// actually keeps its senders/transceivers so replaceStream can be observed.
// ---------------------------------------------------------------------------
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

describe("replaceStream on a link that has no sender of that kind", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds a video sender when the link was built with the camera unplugged", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), ended("video")]));
    expect(pc.senders).toHaveLength(1); // audio only — 85ebec6 skipped the dead camera
    pc.addTrack.mockClear();

    const replugged = live("video");
    const nextAudio = live("audio");
    await link.replaceStream(streamOf([nextAudio, replugged]));

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack.mock.calls[0][0]).toBe(replugged);
    expect(pc.senders.map((s) => s.track)).toContain(replugged);
    // the audio sender is still swapped in place, not re-added
    expect(pc.senders[0].replaceTrack).toHaveBeenCalledWith(nextAudio);
  });

  it("does not add a second sender when one of that kind already exists", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    pc.addTrack.mockClear();
    await link.replaceStream(streamOf([live("audio"), live("video")]));
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(pc.senders).toHaveLength(2);
  });

  it("never adds or swaps in an ENDED track (85ebec6's guard holds on this path too)", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    pc.addTrack.mockClear();
    const videoSender = pc.senders[1];
    await link.replaceStream(streamOf([live("audio"), ended("video")]));
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(null); // cleared, never handed a corpse
  });

  it("re-populates a sender whose track went null instead of stranding it forever", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const videoSender = pc.senders[1];
    await link.replaceStream(streamOf([live("audio")])); // audio-only fallback: video sender goes null
    expect(videoSender.track).toBeNull();
    pc.addTrack.mockClear();

    const camera = live("video");
    await link.replaceStream(streamOf([live("audio"), camera]));
    expect(pc.addTrack).not.toHaveBeenCalled(); // the existing sender is reusable
    expect(videoSender.replaceTrack).toHaveBeenLastCalledWith(camera);
  });

  it("gives a newly added sender the E2EE encrypt transform and the VP9 pin", async () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    const { link, pc } = buildLink(streamOf([live("audio"), ended("video")]), {
      mediaKey: {} as CryptoKey,
      api: "encoded-streams",
    });
    const worker = FakeWorker.instances[0];
    worker.postMessage.mockClear();

    await link.replaceStream(streamOf([live("audio"), live("video")]));

    const added = pc.senders[pc.senders.length - 1];
    expect(added.createEncodedStreams).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ op: "pipe", side: "encrypt" }),
      expect.anything(),
    );
    const transceiver = pc.transceivers.find((t) => t.sender === added)!;
    expect(transceiver.setCodecPreferences).toHaveBeenCalledWith([{ mimeType: "video/VP9" }, { mimeType: "video/rtx" }]);
  });
});
