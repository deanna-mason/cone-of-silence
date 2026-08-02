// __tests__/e2ee-peer.test.ts
// Phase 5D Task 4: feature-detect (e2eeSupport.ts) + PeerLink's e2ee wiring.
// Fake-platform idiom throughout (jsdom, no real RTCPeerConnection) — same
// shape as __tests__/peer-ice.test.ts. The worker's OWN internals
// (e2ee.worker.ts's message/rtctransform handling) are exercised by Task 7's
// e2e, not here — this file only proves PeerLink constructs/wires/tears down
// the worker and transforms correctly, and that e2ee's absence is a true
// no-op (the additivity proof every 4B/4C/5A/5B test depends on).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectE2eeApi, vp9Preferences } from "@/lib/webrtc/e2eeSupport";
import { PeerLink } from "@/lib/webrtc/peer";

// ---------------------------------------------------------------------------
// detectE2eeApi — 3 window shapes
// ---------------------------------------------------------------------------
describe("detectE2eeApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  // D25 (Task 7 review round 2): encoded-streams is preferred now — it's the
  // branch e2e/phase5d-e2e.js actually proves end to end in a real browser;
  // script-transform's receiver side was observed never delivering frames
  // under chrome-headless-shell and has no e2e coverage anywhere.

  it("prefers createEncodedStreams when present (D25)", () => {
    vi.stubGlobal("RTCRtpScriptTransform", class {});
    vi.stubGlobal("RTCRtpSender", { prototype: { createEncodedStreams() {} } }); // present too — encoded-streams still wins
    expect(detectE2eeApi()).toBe("encoded-streams");
  });

  it("falls back to script-transform when createEncodedStreams is absent (D25 fallback stays live)", () => {
    vi.stubGlobal("RTCRtpScriptTransform", class {});
    // No RTCRtpSender stubbed at all — a browser that ships script-transform
    // without the legacy insertable-streams shape must still get e2ee.
    expect(detectE2eeApi()).toBe("script-transform");
  });

  it("returns null when neither API exists", () => {
    expect(detectE2eeApi()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// vp9Preferences — ordering/absence
// ---------------------------------------------------------------------------
describe("vp9Preferences", () => {
  function caps(mimeTypes: string[]): RTCRtpCapabilities {
    return { codecs: mimeTypes.map((mimeType) => ({ mimeType })), headerExtensions: [] } as unknown as RTCRtpCapabilities;
  }

  it("null caps -> null", () => {
    expect(vp9Preferences(null)).toBeNull();
  });

  it("no VP9 anywhere in caps -> null", () => {
    expect(vp9Preferences(caps(["video/H264", "video/VP8"]))).toBeNull();
  });

  it("VP9 first, keeps rtx/red/ulpfec, drops every other codec", () => {
    const result = vp9Preferences(
      caps(["video/H264", "video/VP9", "video/rtx", "video/red", "video/ulpfec", "video/VP8"]),
    );
    expect(result?.map((c) => c.mimeType)).toEqual(["video/VP9", "video/rtx", "video/red", "video/ulpfec"]);
  });

  it("is case-insensitive on mimeType", () => {
    const result = vp9Preferences(caps(["video/vp9"]));
    expect(result?.map((c) => c.mimeType)).toEqual(["video/vp9"]);
  });
});

// ---------------------------------------------------------------------------
// PeerLink e2ee wiring — fake-platform harness
// ---------------------------------------------------------------------------
class FakeSender {
  transform: unknown = null;
  createEncodedStreams = vi.fn(() => ({ readable: {} as ReadableStream, writable: {} as WritableStream }));
  constructor(public track: { kind: string } | null) {}
}
class FakeReceiver {
  transform: unknown = null;
  track: { kind: string } | null = null;
  createEncodedStreams = vi.fn(() => ({ readable: {} as ReadableStream, writable: {} as WritableStream }));
}
class FakeTransceiver {
  setCodecPreferences = vi.fn();
  constructor(
    public sender: FakeSender,
    public receiver: FakeReceiver,
  ) {}
}
interface FakeTrackEvent {
  streams: MediaStream[];
  receiver: FakeReceiver;
}
class FakePC {
  static lastConfig: (RTCConfiguration & { encodedInsertableStreams?: boolean }) | undefined;
  static lastInstance: FakePC | undefined;
  onnegotiationneeded: (() => void | Promise<void>) | null = null;
  onicecandidate: unknown = null;
  ontrack: ((ev: FakeTrackEvent) => void) | null = null;
  onconnectionstatechange: unknown = null;
  restartIce = vi.fn();
  localDescription: unknown = null;
  senders: FakeSender[] = [];
  transceivers: FakeTransceiver[] = [];
  setLocalDescription = vi.fn(async () => {});
  constructor(config?: RTCConfiguration) {
    FakePC.lastConfig = config;
    FakePC.lastInstance = this;
  }
  createDataChannel() {
    return { onopen: null } as unknown as RTCDataChannel;
  }
  addTrack(track: { kind: string }) {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    this.transceivers.push(new FakeTransceiver(sender, new FakeReceiver()));
    return sender as unknown as RTCRtpSender;
  }
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return this.transceivers;
  }
  close() {}
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public url: unknown) {
    FakeWorker.instances.push(this);
  }
}

class FakeRTCRtpScriptTransform {
  constructor(
    public worker: unknown,
    public options: unknown,
  ) {}
}

const noop = () => {};
const mediaKey = {} as CryptoKey;
const vp9Caps = {
  codecs: [{ mimeType: "video/VP9" }, { mimeType: "video/rtx" }],
  headerExtensions: [],
} as unknown as RTCRtpCapabilities;

function trackStream(kinds: string[]): MediaStream {
  return { getTracks: () => kinds.map((kind) => ({ kind })) } as unknown as MediaStream;
}

const base = { polite: true, localStream: trackStream([]), sendSignal: noop, onRemoteStream: noop };

beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", FakePC);
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  FakePC.lastConfig = undefined;
  FakePC.lastInstance = undefined;
  vi.unstubAllGlobals();
});

describe("PeerLink e2ee wiring — e2ee absent (additivity proof)", () => {
  it("no worker is created", () => {
    new PeerLink(base);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("pc config carries no encodedInsertableStreams key", () => {
    new PeerLink(base);
    expect(Object.hasOwn(FakePC.lastConfig!, "encodedInsertableStreams")).toBe(false);
  });

  it("real local tracks get no sender transform / createEncodedStreams call", () => {
    new PeerLink({ ...base, localStream: trackStream(["audio", "video"]) });
    const pc = FakePC.lastInstance!;
    expect(pc.senders).toHaveLength(2);
    for (const s of pc.senders) {
      expect(s.createEncodedStreams).not.toHaveBeenCalled();
      expect(s.transform).toBeNull();
    }
  });

  it("no receiver transform attached in ontrack", () => {
    new PeerLink(base);
    const pc = FakePC.lastInstance!;
    const receiver = new FakeReceiver();
    pc.ontrack!({ streams: [{} as MediaStream], receiver });
    expect(receiver.createEncodedStreams).not.toHaveBeenCalled();
    expect(receiver.transform).toBeNull();
  });

  it("no VP9 pin is attempted, even for a video track", () => {
    new PeerLink({ ...base, localStream: trackStream(["video"]) });
    const pc = FakePC.lastInstance!;
    expect(pc.transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
  });

  it("negotiationneeded never touches getTransceivers/setCodecPreferences", async () => {
    new PeerLink({ ...base, localStream: trackStream(["video"]) });
    const pc = FakePC.lastInstance!;
    await pc.onnegotiationneeded!();
    expect(pc.transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
  });

  it("close() does not throw with no worker to terminate", () => {
    const link = new PeerLink(base);
    expect(() => link.close()).not.toThrow();
  });
});

describe("PeerLink e2ee wiring — legacy encoded-streams api", () => {
  it("adds encodedInsertableStreams:true to the pc config", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" } });
    expect(FakePC.lastConfig?.encodedInsertableStreams).toBe(true);
  });

  it("creates exactly one worker per PeerLink", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" } });
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("attaches a sender transform (createEncodedStreams + a single worker pipe message) per local track", () => {
    new PeerLink({
      ...base,
      localStream: trackStream(["audio", "video"]),
      e2ee: { mediaKey, api: "encoded-streams" },
    });
    const pc = FakePC.lastInstance!;
    expect(pc.senders).toHaveLength(2);
    for (const s of pc.senders) expect(s.createEncodedStreams).toHaveBeenCalledOnce();
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledTimes(2); // one pipe message per track — no separate init
    expect(worker.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ op: "pipe", key: mediaKey, side: "encrypt" }),
      expect.anything(),
    );
  });

  it("attaches a receiver transform off ev.receiver in ontrack", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" } });
    const pc = FakePC.lastInstance!;
    const receiver = new FakeReceiver();
    pc.ontrack!({ streams: [{} as MediaStream], receiver });
    expect(receiver.createEncodedStreams).toHaveBeenCalledOnce();
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ op: "pipe", key: mediaKey, side: "decrypt" }),
      expect.anything(),
    );
  });

  it("second track event for the SAME receiver does not throw, does not double-attach, and does not block onRemoteStream", () => {
    const onRemoteStream = vi.fn();
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" }, onRemoteStream });
    const pc = FakePC.lastInstance!;
    const receiver = new FakeReceiver();
    const stream = {} as MediaStream;
    expect(() => pc.ontrack!({ streams: [stream], receiver })).not.toThrow();
    expect(() => pc.ontrack!({ streams: [stream], receiver })).not.toThrow();
    expect(receiver.createEncodedStreams).toHaveBeenCalledOnce(); // second attach is a no-op
    expect(onRemoteStream).toHaveBeenCalledTimes(2); // but the tile-surfacing call still fires both times
  });

  it("close() terminates the worker", () => {
    const link = new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" } });
    link.close();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});

describe("PeerLink e2ee wiring — script-transform api", () => {
  beforeEach(() => {
    vi.stubGlobal("RTCRtpScriptTransform", FakeRTCRtpScriptTransform);
  });

  it("does NOT add encodedInsertableStreams to the pc config", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "script-transform" } });
    expect(Object.hasOwn(FakePC.lastConfig!, "encodedInsertableStreams")).toBe(false);
  });

  it("attaches sender.transform via RTCRtpScriptTransform with side=encrypt", () => {
    new PeerLink({ ...base, localStream: trackStream(["video"]), e2ee: { mediaKey, api: "script-transform" } });
    const pc = FakePC.lastInstance!;
    const transform = pc.senders[0].transform as FakeRTCRtpScriptTransform;
    expect(transform).toBeInstanceOf(FakeRTCRtpScriptTransform);
    expect(transform.options).toEqual({ key: mediaKey, side: "encrypt" });
    expect(transform.worker).toBe(FakeWorker.instances[0]);
  });

  it("attaches receiver.transform via RTCRtpScriptTransform with side=decrypt in ontrack", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "script-transform" } });
    const pc = FakePC.lastInstance!;
    const receiver = new FakeReceiver();
    pc.ontrack!({ streams: [{} as MediaStream], receiver });
    const transform = receiver.transform as FakeRTCRtpScriptTransform;
    expect(transform).toBeInstanceOf(FakeRTCRtpScriptTransform);
    expect(transform.options).toEqual({ key: mediaKey, side: "decrypt" });
  });

  it("never calls createEncodedStreams (legacy-path-only method)", () => {
    new PeerLink({ ...base, localStream: trackStream(["video"]), e2ee: { mediaKey, api: "script-transform" } });
    const pc = FakePC.lastInstance!;
    expect(pc.senders[0].createEncodedStreams).not.toHaveBeenCalled();
  });

  it("close() still terminates the worker", () => {
    const link = new PeerLink({ ...base, e2ee: { mediaKey, api: "script-transform" } });
    link.close();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("second track event for the SAME receiver does not re-attach a transform", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "script-transform" } });
    const pc = FakePC.lastInstance!;
    const receiver = new FakeReceiver();
    pc.ontrack!({ streams: [{} as MediaStream], receiver });
    const firstTransform = receiver.transform;
    pc.ontrack!({ streams: [{} as MediaStream], receiver });
    expect(receiver.transform).toBe(firstTransform); // untouched by the second event
  });
});

describe("PeerLink e2ee wiring — VP9 codec pin", () => {
  it("pins video transceivers at addTrack time, leaves audio untouched", () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    new PeerLink({
      ...base,
      localStream: trackStream(["audio", "video"]),
      e2ee: { mediaKey, api: "encoded-streams" },
    });
    const pc = FakePC.lastInstance!;
    const audioT = pc.transceivers.find((t) => t.sender.track?.kind === "audio")!;
    const videoT = pc.transceivers.find((t) => t.sender.track?.kind === "video")!;
    expect(audioT.setCodecPreferences).not.toHaveBeenCalled();
    expect(videoT.setCodecPreferences).toHaveBeenCalledWith([{ mimeType: "video/VP9" }, { mimeType: "video/rtx" }]);
  });

  it("skips the pin entirely when vp9Preferences returns null (platform has no VP9)", () => {
    const onE2eeFailure = vi.fn();
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: vi.fn(() => ({ codecs: [{ mimeType: "video/H264" }], headerExtensions: [] })),
    });
    new PeerLink({
      ...base,
      localStream: trackStream(["video"]),
      e2ee: { mediaKey, api: "encoded-streams" },
      onE2eeFailure,
    });
    const pc = FakePC.lastInstance!;
    expect(pc.transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
    expect(onE2eeFailure).toHaveBeenCalledWith(expect.stringContaining("platform has no VP9 codec"));
  });

  it("skips the pin without throwing when RTCRtpSender does not exist on the platform at all", () => {
    // No vi.stubGlobal("RTCRtpSender", ...) here — jsdom defines no such
    // global by default (see detectE2eeApi's own "returns null" test), so
    // this exercises the genuinely-absent case, not just an empty-caps one.
    const onE2eeFailure = vi.fn();
    expect(() =>
      new PeerLink({
        ...base,
        localStream: trackStream(["video"]),
        e2ee: { mediaKey, api: "encoded-streams" },
        onE2eeFailure,
      }),
    ).not.toThrow();
    const pc = FakePC.lastInstance!;
    expect(pc.transceivers[0].setCodecPreferences).not.toHaveBeenCalled();
    expect(onE2eeFailure).toHaveBeenCalledWith(expect.stringContaining("RTCRtpSender.getCapabilities unavailable"));
  });

  it("re-pins every transceiver on negotiationneeded", async () => {
    vi.stubGlobal("RTCRtpSender", { getCapabilities: vi.fn(() => vp9Caps) });
    new PeerLink({ ...base, localStream: trackStream(["video"]), e2ee: { mediaKey, api: "encoded-streams" } });
    const pc = FakePC.lastInstance!;
    pc.transceivers[0].setCodecPreferences.mockClear();
    await pc.onnegotiationneeded!();
    expect(pc.transceivers[0].setCodecPreferences).toHaveBeenCalledOnce();
  });
});

describe("PeerLink e2ee wiring — nonce-rule adjacent (per-pipe isolation)", () => {
  // IvState's own regeneration guarantee is Task 2's (crypto-frame.test.ts);
  // what peer.ts must get right is never letting two tracks share one
  // worker-side pipe, since a shared pipe would mean a shared IvState.
  it("two local tracks get two independent init+pipe message pairs, never a shared pipe", () => {
    new PeerLink({
      ...base,
      localStream: trackStream(["audio", "video"]),
      e2ee: { mediaKey, api: "encoded-streams" },
    });
    const worker = FakeWorker.instances[0];
    const pipeCalls = worker.postMessage.mock.calls.filter(([m]) => (m as { op: string }).op === "pipe") as [
      { readable: unknown; writable: unknown },
    ][];
    expect(pipeCalls).toHaveLength(2);
    expect(pipeCalls[0][0].readable).not.toBe(pipeCalls[1][0].readable);
  });
});

// ---------------------------------------------------------------------------
// Hardening — worker/pipe failures surfaced (Task 4 review item 3)
// ---------------------------------------------------------------------------
describe("PeerLink e2ee wiring — worker/pipe failure surfacing", () => {
  it("a worker onerror surfaces exactly once via onE2eeFailure", () => {
    const onE2eeFailure = vi.fn();
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" }, onE2eeFailure });
    const worker = FakeWorker.instances[0];
    worker.onerror?.({ message: "worker crashed" } as ErrorEvent);
    expect(onE2eeFailure).toHaveBeenCalledOnce();
    expect(onE2eeFailure).toHaveBeenCalledWith(expect.stringContaining("worker crashed"));
  });

  it("a worker onmessageerror surfaces exactly once via onE2eeFailure", () => {
    const onE2eeFailure = vi.fn();
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" }, onE2eeFailure });
    const worker = FakeWorker.instances[0];
    worker.onmessageerror?.({} as MessageEvent);
    expect(onE2eeFailure).toHaveBeenCalledOnce();
  });

  it("a worker-relayed pipe error ({op:'error'}) surfaces exactly once with the worker's detail", () => {
    const onE2eeFailure = vi.fn();
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" }, onE2eeFailure });
    const worker = FakeWorker.instances[0];
    worker.onmessage?.({ data: { op: "error", detail: "e2ee pipe failed (encrypt): boom" } } as MessageEvent);
    expect(onE2eeFailure).toHaveBeenCalledOnce();
    expect(onE2eeFailure).toHaveBeenCalledWith("e2ee pipe failed (encrypt): boom");
  });

  it("never calls onE2eeFailure when e2ee is absent (no worker to fail)", () => {
    const onE2eeFailure = vi.fn();
    new PeerLink({ ...base, onE2eeFailure });
    expect(FakeWorker.instances).toHaveLength(0);
    expect(onE2eeFailure).not.toHaveBeenCalled();
  });

  it("does not throw when a worker fails and onE2eeFailure was never supplied (still optional)", () => {
    new PeerLink({ ...base, e2ee: { mediaKey, api: "encoded-streams" } });
    const worker = FakeWorker.instances[0];
    expect(() => worker.onerror?.({ message: "x" } as ErrorEvent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hardening — orphaned worker cleanup (Task 4 review item 4)
// ---------------------------------------------------------------------------
describe("PeerLink e2ee wiring — orphaned worker cleanup on constructor throw", () => {
  it("terminates the worker created by `new Worker` if the rest of the constructor throws", () => {
    class ThrowingPC extends FakePC {
      addTrack(): RTCRtpSender {
        throw new Error("addTrack boom");
      }
    }
    vi.stubGlobal("RTCPeerConnection", ThrowingPC);
    expect(() =>
      new PeerLink({ ...base, localStream: trackStream(["video"]), e2ee: { mediaKey, api: "encoded-streams" } }),
    ).toThrow("addTrack boom");
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not attempt to terminate anything when e2ee is absent and construction throws", () => {
    class ThrowingPC extends FakePC {
      addTrack(): RTCRtpSender {
        throw new Error("addTrack boom");
      }
    }
    vi.stubGlobal("RTCPeerConnection", ThrowingPC);
    expect(() => new PeerLink({ ...base, localStream: trackStream(["video"]) })).toThrow("addTrack boom");
    expect(FakeWorker.instances).toHaveLength(0); // nothing to leak — no worker was ever created
  });
});
