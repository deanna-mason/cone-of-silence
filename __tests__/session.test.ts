// CallSession integration harness (Phase 4C): fake WebSocket + fake
// RTCPeerConnection drive the real SignalingClient → CallSession → Mesh →
// PeerLink stack. Named 4A rider covered here: reconnect-cred-refresh.
//
// Phase 5D (Task 5): CallSession now requires a `crypto` dep and always
// passes `e2ee` into every PeerLink it builds (D15 — every production call
// is encrypted). FAKE_CRYPTO's proofKey is a REAL HMAC CryptoKey (review fix
// — Important 6: several tests below drive a genuine JoinProof to "proven"
// over the fake "cos" channel, the same wireHonestPeer idiom as
// xfer-bus.test.ts). FakePC/FakeChannel/FakeWorker grew the minimal surface
// PeerLink's e2ee wiring and the "cos" channel touch (getTransceivers, a
// sender with createEncodedStreams, a global Worker stub, labeled data
// channels) so construction doesn't throw and "cos" can be driven directly.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession, type CallStatus, type RemotePeer, type SessionCrypto } from "@/lib/webrtc/session";
import { STAGGER_MS, RESTART_RECOVERY_MS } from "@/lib/webrtc/mesh";
import { JoinProof } from "@/lib/webrtc/joinProof";

const FAKE_CRYPTO: SessionCrypto = {
  keys: {
    mediaKey: {} as CryptoKey,
    xferKey: {} as CryptoKey,
    proofKey: {} as CryptoKey,
  },
  api: "encoded-streams",
};

beforeAll(async () => {
  FAKE_CRYPTO.keys.proofKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
});

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

class FakeChannel {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  bufferedAmountLowThreshold = 0;
  bufferedAmount = 0;
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  sent: unknown[] = [];
  constructor(
    public label: string,
    public init?: RTCDataChannelInit,
  ) {}
  send(data: unknown) {
    this.sent.push(data);
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

// onconnectionstatechange is stored but only invoked where a test explicitly
// calls it (the post-reconnect countersign regression below) — most tests in
// this file don't model connection-state transitions at all.
class FakePC {
  static instances: FakePC[] = [];
  config: RTCConfiguration | undefined;
  addedTracks: MediaStreamTrack[] = [];
  channels: FakeChannel[] = [];
  senders: FakeSender[] = [];
  transceivers: FakeTransceiver[] = [];
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = "new";
  signalingState = "stable";
  closed = false;
  constructor(config?: RTCConfiguration) {
    this.config = config;
    FakePC.instances.push(this);
  }
  createDataChannel(label: string, init?: RTCDataChannelInit) {
    const ch = new FakeChannel(label, init);
    this.channels.push(ch);
    return ch as unknown as RTCDataChannel;
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

function cosChannelOf(pc: FakePC): FakeChannel {
  return pc.channels.find((c) => c.label === "cos")!;
}

/** Wires a real JoinProof, playing the honest remote peer, onto a "cos"
 *  FakeChannel — same idiom as xfer-bus.test.ts's wireHonestPeer. Its
 *  outbound wire text lands on the channel's own onmessage (exactly like
 *  real inbound bytes reaching PeerLink), and the local session's outbound
 *  sends (channel.send) are fed straight into it. Never needs .start() —
 *  the LOCAL session's own proof only cares that ITS OWN challenge gets
 *  answered validly (answering an incoming challenge runs regardless of the
 *  answerer's own phase — see joinProof.ts's answerChallenge doc). */
function wireHonestPeer(proofKey: CryptoKey, remotePeerId: string, selfPeerId: string, cosChannel: FakeChannel): void {
  // PeerLink.send() no-ops unless readyState === "open" — a real channel's
  // onopen firing implies that; this fake one needs it set explicitly.
  cosChannel.readyState = "open";
  const peer = new JoinProof({
    proofKey,
    selfPeerId: remotePeerId,
    remotePeerId: selfPeerId,
    events: {
      onSend: (text) => cosChannel.onmessage?.({ data: text }),
      onProven: () => {},
      onFailed: () => {},
    },
  });
  cosChannel.send = (data: unknown) => {
    cosChannel.sent.push(data);
    if (typeof data === "string") peer.handleMessage(data);
  };
}

/** Polls the fake clock in small async-aware steps until `predicate` holds —
 *  real crypto.subtle HMAC underneath (same reasoning as join-proof.test.ts's
 *  waitForFake). Microtask yields alone are NOT enough: crypto.subtle work
 *  finishes on Node's thread pool and its completion lands as a macrotask, so
 *  on a loaded machine (CI) it can arrive after any fixed number of microtask
 *  drains — that was a real CI-only flake (runs 30947360000/30947579926).
 *  setImmediate is deliberately absent from toFake below, so awaiting it
 *  forces a genuine event-loop turn where thread-pool completions can land. */
async function waitFor(predicate: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("waitFor: condition not met within maxTicks");
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

// ---------------------------------------------------------------------------
// Phase 5D review fixes (Important 6): the honest-pair and post-reconnect
// countersign cases moved/duplicated onto the REAL CallSession harness above
// — a real Mesh + real PeerLink + real JoinProof (real HMAC) actually
// reaching "proven"/"failed", not the hand-mirrored GatingHarness in
// join-proof.test.ts (which validates the intended design, not this file's
// shipped session.ts).
// ---------------------------------------------------------------------------
describe("Phase 5D join-proof gating on the real CallSession stack", () => {
  it("honest pair: roster/messages gated on the real 'cos' channel until proven, then flow", async () => {
    startAndOpen().serverSays({
      v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A,
    });
    vi.advanceTimersByTime(STAGGER_MS);
    const cos = cosChannelOf(FakePC.instances[0]);

    const messages: [string, string][] = [];
    session.events.on("message", (peerId, text) => messages.push([peerId, text]));

    expect(rosters.at(-1)).toEqual([]); // invisible before any proof starts

    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, "p1", "me", cos);
    cos.onopen!();

    // Before proof completes: an inbound app message must never surface.
    cos.onmessage!({ data: "too-early" });
    expect(messages).toEqual([]);

    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "p1") ?? false);

    expect(rosters.at(-1)).toEqual([{ peerId: "p1", stream: null, connectionState: "new" }]);

    cos.onmessage!({ data: "post-proof" });
    expect(messages).toEqual([["p1", "post-proof"]]);

    session.sendAll("hello");
    expect(cos.sent).toContain("hello");
  });

  it("having ever proven someone survives their departure — a later wrong-secret joiner never triggers countersign-failed (BLOCKING round-2 review fix)", async () => {
    // B (this session) joins a populated room and proves A — an entirely
    // honest exchange. joinedPopulatedRoom latches true here, same as any
    // legitimate joiner.
    const ws = startAndOpen();
    ws.serverSays({ v: 1, t: "joined", selfId: "me", peers: [{ peerId: "A" }], ice: ICE_A });
    vi.advanceTimersByTime(STAGGER_MS);
    const cosA = cosChannelOf(FakePC.instances[0]);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, "A", "me", cosA);
    cosA.onopen!();
    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "A") ?? false);

    // A hangs up — peerLeft deletes A's proof entirely. Under the
    // joinedPopulatedRoom-only fix (round 1), `this.proofs` would now be
    // empty, and the NEXT peer to fail would vacuously satisfy
    // `every(...)`. everProvenAnyone (round 2) must prevent that.
    ws.serverSays({ v: 1, t: "peer-left", peerId: "A" });
    expect(rosters.at(-1)).toEqual([]);

    // A wrong-secret peer C joins next — its proof genuinely fails (bad-mac).
    ws.serverSays({ v: 1, t: "peer-joined", peerId: "C" });
    vi.advanceTimersByTime(STAGGER_MS);
    const pcC = FakePC.instances.at(-1)!;
    const cosC = cosChannelOf(pcC);
    const wrongKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const impostor = new JoinProof({
      proofKey: wrongKey,
      selfPeerId: "C",
      remotePeerId: "me",
      events: { onSend: (text) => cosC.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cosC.readyState = "open";
    cosC.send = (data: unknown) => {
      cosC.sent.push(data);
      if (typeof data === "string") impostor.handleMessage(data);
    };
    cosC.onopen!();
    await waitFor(() => pcC.closed); // C's bad-mac failure closes its link

    // B already proved someone, once — that can never be un-proven by later
    // churn. The right-secret host here must see no status change at all.
    expect(statuses).not.toContain("countersign-failed");
    expect(rosters.at(-1)).toEqual([]);
  });

  it("a signaling reconnect never resurrects a host's impolite squatter into a countersign-failed misfire (Critical 2 / D24 review fix)", async () => {
    // Host's FIRST "entered" is an EMPTY room — joinedPopulatedRoom latches
    // false PERMANENTLY, no matter what any later "entered" (a reconnect's
    // re-emit, carrying the room's current peer list) looks like.
    const ws1 = startAndOpen();
    ws1.serverSays({ v: 1, t: "joined", selfId: "me", peers: [] });
    expect(statuses).toEqual(["waiting"]);

    // A wrong-secret squatter joins US (peer-joined ⇒ addNewcomer ⇒ WE are
    // impolite toward it) — the shape Critical 2 named exactly.
    ws1.serverSays({ v: 1, t: "peer-joined", peerId: "squatter" });
    vi.advanceTimersByTime(STAGGER_MS);
    const pc1 = FakePC.instances.at(-1)!;
    const cos1 = cosChannelOf(pc1);

    const wrongKey1 = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    // A bare JoinProof standing in for the squatter, holding a DIFFERENT key
    // — genuinely fails the countersign (bad-mac), not a timeout.
    const impostor1 = new JoinProof({
      proofKey: wrongKey1,
      selfPeerId: "squatter",
      remotePeerId: "me",
      events: { onSend: (text) => cos1.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cos1.readyState = "open";
    cos1.send = (data: unknown) => {
      cos1.sent.push(data);
      if (typeof data === "string") impostor1.handleMessage(data);
    };
    cos1.onopen!();
    // Bad-mac closes the link (pc.close()) — this file doesn't model
    // connectionState transitions, so pc.closed is the observable signal
    // that the proof genuinely failed (a timeout would NOT close it —
    // Important 4 — so this also confirms we're on the bad-mac path).
    await waitFor(() => pc1.closed);

    expect(statuses).not.toContain("countersign-failed"); // D18 — right-secret host, no status change
    expect(rosters.at(-1)).toEqual([]); // squatter never surfaced

    // Socket blip: reconnect. SignalingClient re-emits "entered" with the
    // room's CURRENT peer list — the squatter is still server-side present
    // (Important 3: a refused peer's own socket isn't ours to close), so the
    // reconnect's "entered" is populated even though our OWN first one wasn't.
    ws1.close();
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(20_000);
    const ws2 = lastWS();
    ws2.open();
    ws2.serverSays({
      v: 1, t: "joined", selfId: "me2", peers: [{ peerId: "squatter" }], ice: ICE_A,
    });
    vi.advanceTimersByTime(STAGGER_MS);
    const pc2 = FakePC.instances.at(-1)!;
    const cos2 = cosChannelOf(pc2);

    const wrongKey2 = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const impostor2 = new JoinProof({
      proofKey: wrongKey2,
      selfPeerId: "squatter",
      remotePeerId: "me2",
      events: { onSend: (text) => cos2.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cos2.readyState = "open";
    cos2.send = (data: unknown) => {
      cos2.sent.push(data);
      if (typeof data === "string") impostor2.handleMessage(data);
    };
    cos2.onopen!();
    await waitFor(() => pc2.closed);

    // The exact regression: pre-fix, addExistingPeers(["squatter"], false)
    // on THIS "entered" made us polite toward it, and polite-everyone-failed
    // fired the refusal card here. Post-fix, joinedPopulatedRoom was decided
    // once, on the FIRST entered (empty), and this reconnect can't change it.
    expect(statuses).not.toContain("countersign-failed");
    expect(rosters.at(-1)).toEqual([]);
  });

  it("countersign-failed stops signaling so it can never dissolve back into a live call (Important 3 review fix)", async () => {
    // WE are the wrong-secret joiner this time: our first "entered" already
    // shows an existing peer — joinedPopulatedRoom latches true.
    const ws = startAndOpen();
    ws.serverSays({ v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A });
    vi.advanceTimersByTime(STAGGER_MS);
    const cos1 = cosChannelOf(FakePC.instances[0]);

    const wrongKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const impostor = new JoinProof({
      proofKey: wrongKey,
      selfPeerId: "p1",
      remotePeerId: "me",
      events: { onSend: (text) => cos1.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cos1.readyState = "open";
    cos1.send = (data: unknown) => {
      cos1.sent.push(data);
      if (typeof data === "string") impostor.handleMessage(data);
    };
    cos1.onopen!();
    await waitFor(() => statuses.includes("countersign-failed"));

    // Without the fix, the socket stays alive and a LATER peerJoined whose
    // proof actually succeeds would flip status back to "connected" via
    // onRoster's "≥1 stream ⇒ connected" — resurrecting a terminal card
    // into a live call (the exact shape 5D exists to close).
    expect(ws.readyState).toBe(3); // signaling.stop() actually closed the socket
    expect(statuses.at(-1)).toBe("countersign-failed");
  });

  it("a timed-out proof never counts toward countersign-failed, even once a DIFFERENT peer genuinely bad-macs (Important 4 completion review fix)", async () => {
    // WE joined a populated room with two peers — X (goes silent, times out)
    // and Y (wrong secret, genuinely bad-macs). Before this fix,
    // checkCountersignFailed read JoinProof.phase, which collapses "timeout"
    // and "bad-mac" into the same terminal "failed" — so X's mere silence
    // would count toward "every link failed" once Y's real bad-mac ran the
    // check, converting a stalled handshake into an accusation it never made.
    const ws = startAndOpen();
    ws.serverSays({
      v: 1, t: "joined", selfId: "me", peers: [{ peerId: "X" }, { peerId: "Y" }], ice: ICE_A,
    });
    vi.advanceTimersByTime(STAGGER_MS * 2);
    const cosX = cosChannelOf(FakePC.instances[0]);
    const cosY = cosChannelOf(FakePC.instances[1]);

    // X: channel opens, nobody ever answers — pure timeout, no bad-mac.
    cosX.readyState = "open";
    cosX.onopen!();
    vi.advanceTimersByTime(5_000); // JoinProof's default timeoutMs

    // Y: wrong secret, answers with a genuinely bad mac.
    const wrongKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const impostorY = new JoinProof({
      proofKey: wrongKey,
      selfPeerId: "Y",
      remotePeerId: "me",
      events: { onSend: (text) => cosY.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cosY.readyState = "open";
    cosY.send = (data: unknown) => {
      cosY.sent.push(data);
      if (typeof data === "string") impostorY.handleMessage(data);
    };
    cosY.onopen!();
    await waitFor(() => FakePC.instances[1].closed);

    // Y's bad-mac genuinely fails and closes its link; X only timed out
    // (link untouched, per Important 4). `every(...)` must be false because
    // X's failReason is "timeout", not "bad-mac" — no card.
    expect(statuses).not.toContain("countersign-failed");
  });

  it("a link-factory throw during construction does not leave a stale proof pinning checkCountersignFailed forever (Minor 8 review fix)", async () => {
    let throwNext = true;
    class ThrowingPC extends FakePC {
      addTrack(track: MediaStreamTrack) {
        if (throwNext) {
          throwNext = false;
          throw new Error("addTrack boom");
        }
        return super.addTrack(track);
      }
    }
    vi.stubGlobal("RTCPeerConnection", ThrowingPC);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    startAndOpen().serverSays({
      v: 1, t: "joined", selfId: "me",
      peers: [{ peerId: "p1" }, { peerId: "p2" }], ice: ICE_A,
    });
    vi.advanceTimersByTime(STAGGER_MS * 2); // both staggered constructions run — p1 throws, p2 succeeds
    expect(FakePC.instances).toHaveLength(2); // p1's pc object exists; its addTrack just threw

    const cos2 = cosChannelOf(FakePC.instances[1]);
    const wrongKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const impostor = new JoinProof({
      proofKey: wrongKey,
      selfPeerId: "p2",
      remotePeerId: "me",
      events: { onSend: (text) => cos2.onmessage?.({ data: text }), onProven: () => {}, onFailed: () => {} },
    });
    cos2.readyState = "open";
    cos2.send = (data: unknown) => {
      cos2.sent.push(data);
      if (typeof data === "string") impostor.handleMessage(data);
    };
    cos2.onopen!();
    await waitFor(() => statuses.includes("countersign-failed"));

    // Without the fix, p1's proof — registered in session's proofs map right
    // before the throwing PeerLink construction — would linger forever at
    // "pending" (mesh evicted the ENTRY, but nothing disposed/deleted the
    // proof), so checkCountersignFailed's `every(...)` could never be true
    // again for the rest of the session, silently disabling the refusal
    // card p2's genuine bad-mac failure should have raised.
    expect(statuses.at(-1)).toBe("countersign-failed");
    logged.mockRestore();
  });
});
