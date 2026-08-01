// CallSession integration harness (Phase 4C): fake WebSocket + fake
// RTCPeerConnection drive the real SignalingClient → CallSession → Mesh →
// PeerLink stack. Named 4A rider covered here: reconnect-cred-refresh.
//
// Phase 5D (Task 5): CallSession now requires a `crypto` dep and always
// passes `e2ee` into every PeerLink it builds (D15 — every production call
// is encrypted). FAKE_CRYPTO below is a placeholder (opaque CryptoKey
// stand-ins, never fed to real crypto.subtle in these tests — no test here
// ever opens the "cos" channel, so no JoinProof ever starts and proofKey is
// never actually signed with). FakePC/FakeWorker below grew the minimal
// surface PeerLink's e2ee wiring touches (getTransceivers, a sender with
// createEncodedStreams, a global Worker stub) so construction doesn't throw;
// none of it is otherwise exercised by these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession, type CallStatus, type RemotePeer, type SessionCrypto } from "@/lib/webrtc/session";
import { STAGGER_MS } from "@/lib/webrtc/mesh";

const FAKE_CRYPTO: SessionCrypto = {
  keys: {
    mediaKey: {} as CryptoKey,
    xferKey: {} as CryptoKey,
    proofKey: {} as CryptoKey,
  },
  api: "encoded-streams",
};

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSays(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakeSender {
  transform: unknown = null;
  createEncodedStreams = () => ({ readable: {} as ReadableStream, writable: {} as WritableStream });
  constructor(public track: MediaStreamTrack) {}
}
class FakeTransceiver {
  setCodecPreferences = vi.fn();
  constructor(public sender: FakeSender) {}
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

// connectionState is not modeled here — onconnectionstatechange is stored but
// never invoked, so PeerLink's onConnectionState never fires; a future slice
// exercising connection-state transitions must add that.
class FakePC {
  static instances: FakePC[] = [];
  config: RTCConfiguration | undefined;
  addedTracks: MediaStreamTrack[] = [];
  senders: FakeSender[] = [];
  transceivers: FakeTransceiver[] = [];
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  signalingState = "stable";
  closed = false;
  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakePC.instances.push(this);
  }
  createDataChannel() {
    return { onopen: null } as unknown as RTCDataChannel;
  }
  addTrack(track: MediaStreamTrack) {
    this.addedTracks.push(track);
    const sender = new FakeSender(track);
    this.senders.push(sender);
    this.transceivers.push(new FakeTransceiver(sender));
    return sender as unknown as RTCRtpSender;
  }
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return this.transceivers;
  }
  restartIce() {}
  close() {
    this.closed = true;
  }
}

const ROOM = "r".repeat(22);
const trackA = { kind: "video" } as MediaStreamTrack;
const trackB = { kind: "video" } as MediaStreamTrack;
const streamA = { getTracks: () => [trackA] } as unknown as MediaStream;
const streamB = { getTracks: () => [trackB] } as unknown as MediaStream;

let session: CallSession;
let statuses: CallStatus[];
let rosters: RemotePeer[][];

function lastWS(): FakeWS {
  return FakeWS.instances.at(-1)!;
}

function startAndOpen(): FakeWS {
  session.start();
  const ws = lastWS();
  ws.open();
  return ws;
}

beforeEach(() => {
  localStorage.clear(); // isolate cos-create-token across tests — don't let declaration order matter
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic backoff
  FakeWS.instances = [];
  FakePC.instances = [];
  FakeWorker.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("Worker", FakeWorker);
  statuses = [];
  rosters = [];
  session = new CallSession(ROOM, streamA, FAKE_CRYPTO, "ws://test/ws");
  session.events.on("status", (s) => statuses.push(s));
  session.events.on("roster", (r) => rosters.push(r));
});

afterEach(() => {
  session.leave();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ICE_A = [{ urls: "stun:a.example:1" }];
const ICE_B = [{ urls: "stun:b.example:2" }, { urls: "turn:b.example:3", username: "9", credential: "m" }];

describe("entry and roster", () => {
  it("empty room → waiting; no links built", () => {
    startAndOpen().serverSays({ v: 1, t: "joined", selfId: "me", peers: [] });
    expect(statuses).toEqual(["waiting"]);
    vi.advanceTimersByTime(STAGGER_MS * 4);
    expect(FakePC.instances).toHaveLength(0);
  });

  it("populated room → links deferred off the handler tick; roster stays empty until proven (Phase 5D)", () => {
    startAndOpen().serverSays({
      v: 1, t: "joined", selfId: "me",
      peers: [{ peerId: "p1" }, { peerId: "p2" }], ice: ICE_A,
    });
    // Phase 5D (Task 5): peers are invisible to the roster until their own
    // join-proof succeeds (D16/D18). This harness's FakePC never opens a
    // "cos" channel, so no proof ever starts — the roster staying empty here
    // is the correct secure-by-default behavior (pre-5D this asserted
    // ["p1","p2"] immediately; the gating state machine itself, including
    // the proven case, is exercised end-to-end in join-proof.test.ts).
    expect(rosters.at(-1)).toEqual([]);
    expect(FakePC.instances).toHaveLength(0); // 4B rule: none in the handler tick
    vi.advanceTimersByTime(STAGGER_MS * 2);
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[0].config?.iceServers).toEqual(ICE_A);
    expect(rosters.at(-1)).toEqual([]); // still unproven after link construction
  });
});

describe("reconnect", () => {
  it("cred refresh: links rebuilt after a reconnect use the FRESH ice servers (4A rider, by name)", () => {
    startAndOpen().serverSays({
      v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A,
    });
    vi.advanceTimersByTime(STAGGER_MS);
    expect(FakePC.instances[0].config?.iceServers).toEqual(ICE_A);

    lastWS().close(); // outage
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(rosters.at(-1)).toEqual([]); // links torn down
    expect(FakePC.instances[0].closed).toBe(true);

    vi.advanceTimersByTime(20_000); // ride the backoff to the next socket
    const ws2 = lastWS();
    expect(ws2).not.toBe(FakeWS.instances[0]);
    ws2.open();
    ws2.serverSays({
      v: 1, t: "joined", selfId: "me2", peers: [{ peerId: "p1" }], ice: ICE_B,
    });
    vi.advanceTimersByTime(STAGGER_MS);
    expect(FakePC.instances).toHaveLength(2);
    expect(FakePC.instances[1].config?.iceServers).toEqual(ICE_B); // re-minted creds
  });

  it("device switch during the stagger window: the late-built link gets the NEW stream", async () => {
    startAndOpen().serverSays({
      v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A,
    });
    await session.setLocalStream(streamB); // before the stagger fires
    vi.advanceTimersByTime(STAGGER_MS);
    expect(FakePC.instances[0].addedTracks).toEqual([trackB]);
  });
});

describe("refusal mapping", () => {
  it("cold room-not-found → room-not-found status", () => {
    startAndOpen().serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(statuses.at(-1)).toBe("room-not-found");
  });

  it("post-entry exhausted recovery → recovery-failed status", () => {
    startAndOpen().serverSays({ v: 1, t: "joined", selfId: "me", peers: [] });
    lastWS().close();
    vi.advanceTimersByTime(120_000); // sail past RETRY_DEADLINE_MS incl. backoff
    const ws2 = lastWS();
    ws2.open();
    ws2.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(statuses.at(-1)).toBe("recovery-failed");
  });

  it("post-entry create-refused keeps its own status — a revoked token is not a patience story", () => {
    localStorage.setItem("cos-create-token", "t".repeat(22));
    startAndOpen().serverSays({ v: 1, t: "joined", selfId: "me", peers: [] });
    lastWS().close();
    vi.advanceTimersByTime(20_000);
    const ws2 = lastWS();
    ws2.open();
    ws2.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" }); // triggers create
    ws2.serverSays({ v: 1, t: "error", reason: "create-refused", message: "" });
    expect(statuses.at(-1)).toBe("create-refused"); // NOT recovery-failed (controller ruling, Task 1 fix round)
  });
});
