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

    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, stream);

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack).toHaveBeenCalledWith(track, stream);
  });

  it("routes through the E2EE funnel: encrypt transform + VP9 pin on the screen sender", async () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    const { link, pc } = buildLink(streamOf([live("audio")]), { mediaKey: {} as CryptoKey, api: "encoded-streams" });
    const worker = FakeWorker.instances[0];
    worker.postMessage.mockClear();
    const track = screenTrack();

    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, screenStreamOf(track));

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
    await link.startScreenShare({ video: first as unknown as MediaStreamTrack, audio: null }, screenStreamOf(first));
    const screenSender = pc.senders[pc.senders.length - 1];
    pc.addTrack.mockClear();

    const second = screenTrack();
    await link.startScreenShare({ video: second as unknown as MediaStreamTrack, audio: null }, screenStreamOf(second));

    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(screenSender.replaceTrack).toHaveBeenLastCalledWith(second);
  });
});

describe("stopScreenShare", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears the screen sender's track (no teardown, no renegotiation)", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const track = screenTrack();
    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, screenStreamOf(track));
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
    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, screenStreamOf(track));
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
    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, screenStreamOf(track));
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
    await link.startScreenShare({ video: track as unknown as MediaStreamTrack, audio: null }, screenStreamOf(track));
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

// Screen-share AUDIO (tab/system sound the sharer ticked in the browser's
// picker): a second screen sender of kind "audio", associated with the SAME
// screen stream so the far side files it under the screen tile — never with
// the mic/camera stream, and never a device slot. Through the same funnel,
// so it is encrypted exactly like the mic.
describe("screen-share audio", () => {
  afterEach(() => vi.unstubAllGlobals());

  const share = (link: PeerLink, video: Track, audio: Track | null, stream: MediaStream) =>
    link.startScreenShare(
      { video: video as unknown as MediaStreamTrack, audio: audio as unknown as MediaStreamTrack | null },
      stream,
    );

  it("adds the screen audio track as its own sender on the screen's stream", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    pc.addTrack.mockClear();
    const video = screenTrack();
    const audio = live("audio");
    const stream = streamOf([video, audio]);

    await share(link, video, audio, stream);

    expect(pc.addTrack).toHaveBeenCalledTimes(2);
    expect(pc.addTrack).toHaveBeenCalledWith(video, stream);
    expect(pc.addTrack).toHaveBeenCalledWith(audio, stream);
  });

  it("the screen audio sender gets the E2EE encrypt transform and no VP9 pin", async () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    const { link, pc } = buildLink(streamOf([live("audio")]), { mediaKey: {} as CryptoKey, api: "encoded-streams" });
    const worker = FakeWorker.instances[0];
    worker.postMessage.mockClear();
    const video = screenTrack();
    const audio = live("audio");

    await share(link, video, audio, streamOf([video, audio]));

    const audioSender = pc.senders.find((s) => s.track === audio)!;
    expect(audioSender.createEncodedStreams).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(2); // one encrypt pipe per screen sender
    for (const call of worker.postMessage.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ op: "pipe", side: "encrypt" }));
    }
    const transceiver = pc.transceivers.find((t) => t.sender === audioSender)!;
    expect(transceiver.setCodecPreferences).not.toHaveBeenCalled();
  });

  it("a share without audio adds no audio sender", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    pc.addTrack.mockClear();
    const video = screenTrack();

    await share(link, video, null, streamOf([video]));

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack).toHaveBeenCalledWith(video, expect.anything());
  });

  it("a re-share re-arms BOTH parked screen senders in place", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const v1 = screenTrack();
    const a1 = live("audio");
    const carrier = streamOf([v1, a1]);
    await share(link, v1, a1, carrier);
    const videoSender = pc.senders.find((s) => s.track === v1)!;
    const audioSender = pc.senders.find((s) => s.track === a1)!;
    await link.stopScreenShare();
    pc.addTrack.mockClear();

    const v2 = screenTrack();
    const a2 = live("audio");
    await share(link, v2, a2, carrier);

    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(videoSender.replaceTrack).toHaveBeenLastCalledWith(v2);
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(a2);
  });

  it("a silent share after an audible one keeps the old audio sender null (no stale sound)", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const v1 = screenTrack();
    const a1 = live("audio");
    const carrier = streamOf([v1, a1]);
    await share(link, v1, a1, carrier);
    const audioSender = pc.senders.find((s) => s.track === a1)!;

    await share(link, screenTrack(), null, carrier);

    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it("an audible re-share after a silent first share adds the audio sender on the carrier stream", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const v1 = screenTrack();
    const carrier = streamOf([v1]);
    await share(link, v1, null, carrier);
    pc.addTrack.mockClear();

    const audio = live("audio");
    await share(link, screenTrack(), audio, carrier);

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack).toHaveBeenCalledWith(audio, carrier);
  });

  it("stop clears the audio sender too", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const video = screenTrack();
    const audio = live("audio");
    await share(link, video, audio, streamOf([video, audio]));
    const audioSender = pc.senders.find((s) => s.track === audio)!;

    await link.stopScreenShare();

    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(null);
  });

  it("a mic switch never lands on the screen audio sender, live or stopped", async () => {
    const { link, pc } = buildLink(streamOf([live("audio"), live("video")]));
    const micSender = pc.senders[0];
    const video = screenTrack();
    const audio = live("audio");
    await share(link, video, audio, streamOf([video, audio]));
    const audioSender = pc.senders.find((s) => s.track === audio)!;
    pc.addTrack.mockClear();

    await link.replaceStream(streamOf([live("audio"), live("video")]));
    expect(audioSender.replaceTrack).not.toHaveBeenCalled(); // live share: untouched
    await link.stopScreenShare();
    audioSender.replaceTrack.mockClear();
    const thirdMic = live("audio");
    await link.replaceStream(streamOf([thirdMic, live("video")]));

    expect(audioSender.replaceTrack).not.toHaveBeenCalled();
    expect(micSender.replaceTrack).toHaveBeenLastCalledWith(thirdMic);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("the screen audio sender does not count as covering 'audio' — a link built mic-less still gets a mic sender", async () => {
    const { link, pc } = buildLink(streamOf([ended("audio"), live("video")]));
    const video = screenTrack();
    const audio = live("audio");
    await share(link, video, audio, streamOf([video, audio]));
    pc.addTrack.mockClear();

    const mic = live("audio");
    await link.replaceStream(streamOf([mic, live("video")]));

    expect(pc.addTrack).toHaveBeenCalledOnce();
    expect(pc.addTrack.mock.calls[0][0]).toBe(mic);
  });
});
