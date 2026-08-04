// Phase 5B Task 3: CallSession's xfer surface (channelState/xferMessage/
// xferDrain events, sendXferTo/xferBufferedAmount) and the useCallSession
// hook's bus.xfer port that exposes them to React.
//
// Two harnesses, both driving the REAL stack (no mesh/peer mocking, per the
// task's hard constraint):
//   - "CallSession xfer events": fake WebSocket + fake RTCPeerConnection (the
//     session.test.ts idiom), extended with a fake data channel (the
//     xfer-channel.test.ts idiom) so cos-xfer's open/message/drain can be
//     driven directly against the real Mesh + PeerLink.
//   - "useCallSession bus.xfer": renderHook over the same fakes — the hook
//     builds its own CallSession internally, so there is no lower seam to
//     mock without losing coverage of the wiring itself.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { CallSession, type ChannelLifecycle, type ChannelName, type RemotePeer, type SessionCrypto } from "@/lib/webrtc/session";
import { useCallSession } from "@/hooks/useCallSession";
import { STAGGER_MS } from "@/lib/webrtc/mesh";
import { JoinProof } from "@/lib/webrtc/joinProof";
import type { RoomKeys } from "@/lib/roomLink";

// Phase 5D (Task 5): CallSession now requires a `crypto` dep (D15 — every
// production call is encrypted), and the hook derives its own crypto keys
// asynchronously before ever constructing a session. FAKE_CRYPTO/the mocked
// deriveRoomKeys+detectE2eeApi below exist so construction doesn't throw and
// the hook's async derivation step resolves deterministically. Review fix
// (Critical 1): the cos-xfer channel is now proof-gated, so several of this
// file's tests need a REAL, working proofKey (not an opaque stand-in) to
// drive a genuine JoinProof to "proven" over the fake "cos" channel — a real
// HMAC CryptoKey (not derived via HKDF; that derivation isn't what's under
// test here) is generated once in beforeAll.
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

vi.mock("@/lib/crypto/derive", () => ({
  deriveRoomKeys: vi.fn(async () => FAKE_CRYPTO.keys),
}));
vi.mock("@/lib/webrtc/e2eeSupport", () => ({
  detectE2eeApi: vi.fn(() => FAKE_CRYPTO.api),
  // Minor 9 (review fix): peer.ts imports vp9Preferences unconditionally —
  // omitting it here only survived because jsdom has no global RTCRtpSender,
  // so applyVp9Pin's early-return exits before ever calling it. Included for
  // real, so that stays true by construction rather than by accident.
  vp9Preferences: vi.fn(() => null),
}));

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

// connectionState is not modeled (onconnectionstatechange stored, never
// invoked) — same scope limit as session.test.ts's FakePC; irrelevant here.
// getTransceivers/FakeSender/FakeWorker (Phase 5D, Task 5): the minimal
// surface PeerLink's now-always-on e2ee wiring touches (see FAKE_CRYPTO's
// doc above) — none of it is otherwise exercised by these tests.
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
const ROOM_KEYS: RoomKeys = { roomId: ROOM, secret: "s".repeat(22) };
const track = { kind: "video" } as MediaStreamTrack;
const stream = { getTracks: () => [track] } as unknown as MediaStream;
const ICE_A = [{ urls: "stun:a.example:1" }];

function lastWS(): FakeWS {
  return FakeWS.instances.at(-1)!;
}

function xferChannelOf(pc: FakePC): FakeChannel {
  return pc.channels.find((c) => c.label === "cos-xfer")!;
}

function cosChannelOf(pc: FakePC): FakeChannel {
  return pc.channels.find((c) => c.label === "cos")!;
}

function enterWithOnePeer(ws: FakeWS): void {
  ws.serverSays({ v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A });
}

/** Wires a real JoinProof, playing the honest remote peer "p1", onto the
 *  "cos" FakeChannel: its outbound wire text lands on the channel's own
 *  onmessage (exactly like real inbound bytes reaching PeerLink), and the
 *  local session's outbound sends (channel.send) are fed straight into it.
 *  It never needs to call .start() itself — the LOCAL session's own proof
 *  only cares that ITS OWN challenge gets answered validly, and answering
 *  an incoming challenge runs regardless of this peer's own phase (see
 *  joinProof.ts's answerChallenge doc) — same loopback idiom as
 *  join-proof.test.ts's BusEvents/GatingHarness. */
function wireHonestPeer(proofKey: CryptoKey, cosChannel: FakeChannel): void {
  // PeerLink.send() checks readyState !== "open" and silently no-ops
  // otherwise — a real channel's onopen firing implies readyState is
  // already "open"; this fake one needs it set explicitly.
  cosChannel.readyState = "open";
  const peer = new JoinProof({
    proofKey,
    selfPeerId: "p1",
    remotePeerId: "me", // matches enterWithOnePeer's serverSays selfId
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

/** Polls the fake clock in small async-aware steps (real crypto.subtle HMAC
 *  underneath, same reasoning as join-proof.test.ts's waitForFake) until
 *  `predicate` holds, wrapped in `act` so any React state updates the real
 *  CallSession/hook makes along the way are flushed and not warned about. */
async function waitFor(predicate: () => boolean, maxTicks = 1000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    // Real event-loop turn first (setImmediate is unfaked in toFake below) so
    // crypto.subtle thread-pool completions can land on loaded CI runners —
    // microtask drains alone starved them (see session/join-proof waiters).
    await new Promise<void>((r) => setImmediate(r));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  throw new Error("waitFor: condition not met within maxTicks");
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeWS.instances = [];
  FakePC.instances = [];
  FakeWorker.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CallSession xfer events", () => {
  let session: CallSession;

  afterEach(() => {
    session.leave();
  });

  function buildLiveLink(): { pc: FakePC; xfer: FakeChannel } {
    session.start();
    const ws = lastWS();
    ws.open();
    enterWithOnePeer(ws);
    vi.advanceTimersByTime(STAGGER_MS);
    const pc = FakePC.instances[0];
    return { pc, xfer: xferChannelOf(pc) };
  }

  it("(a) mesh onChannelState -> session channelState event with all four args — proof-gated, with the open channels replayed on proven (Minor 2 review fix)", async () => {
    session = new CallSession(ROOM, stream, FAKE_CRYPTO, "ws://test/ws");
    const events: [string, ChannelName, ChannelLifecycle, string | undefined][] = [];
    const rosters: RemotePeer[][] = [];
    session.events.on("channelState", (peerId, channel, state, detail) =>
      events.push([peerId, channel, state, detail]),
    );
    session.events.on("roster", (r) => rosters.push(r));
    const { pc, xfer } = buildLiveLink();

    // Final-review Minor 2: channelState was the last ungated member of the
    // trust-gate enumeration (its three siblings — onMessage, onXferMessage,
    // onXferDrain — were all gated). An unproven peer's channel lifecycle
    // must not drive app state either (useEpisodeExchange keys canSend off
    // exactly this event).
    xfer.onopen!();
    expect(events).toEqual([]);

    // SCTP routinely establishes before the proof settles, so the gate can't
    // just drop these: whatever is still open at proven time is replayed,
    // or the send panel would stay wedged shut for the life of the call.
    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    cos.onopen!();
    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "p1") ?? false);

    expect(events).toEqual([
      ["p1", "cos", "open", undefined],
      ["p1", "xfer", "open", undefined],
    ]);

    // Post-proof, everything forwards live, all four args intact.
    xfer.onerror!({ error: { message: "sctp reset" } });
    expect(events.at(-1)).toEqual(["p1", "xfer", "error", "sctp reset"]);

    xfer.onclose!();
    expect(events.at(-1)).toEqual(["p1", "xfer", "closed", undefined]);
  });

  it("(a2) a pre-proof 'error' on a still-open channel does not cancel its replay — the replay mirrors mesh, not a parallel truth", async () => {
    session = new CallSession(ROOM, stream, FAKE_CRYPTO, "ws://test/ws");
    const events: [string, ChannelName, ChannelLifecycle, string | undefined][] = [];
    const rosters: RemotePeer[][] = [];
    session.events.on("channelState", (peerId, channel, state, detail) =>
      events.push([peerId, channel, state, detail]),
    );
    session.events.on("roster", (r) => rosters.push(r));
    const { pc, xfer } = buildLiveLink();

    // "error" is NOT a close: mesh deliberately leaves the open flag alone on
    // it (mesh.ts's onChannelState — "an error is often followed by a close,
    // and the close flips it then"), and peer.ts fires onerror on a channel
    // that is still open. A replay driven off a session-local "last state
    // seen" map would read "error" here and skip the channel, leaving the app
    // permanently unaware that xfer is open — canSend wedged false for the
    // life of the link while mesh.sendXferTo would happily succeed. That is
    // the exact wedge the replay exists to prevent, so the replay reads
    // mesh's own channelOpen/xferOpen and the two cannot diverge.
    xfer.readyState = "open";
    xfer.onopen!();
    xfer.onerror!({ error: { message: "sctp hiccup" } });
    expect(events).toEqual([]); // both gated — still unproven

    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    cos.onopen!();
    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "p1") ?? false);

    expect(events).toEqual([
      ["p1", "cos", "open", undefined],
      ["p1", "xfer", "open", undefined], // replayed despite the error — mesh still holds it open
    ]);
    expect(session.sendXferTo("p1", "x")).toBe(true); // and the send path agrees

    // The eventual real close still forwards live, so the engines' only
    // stall recovery (useEpisodeExchange's handleChannelClosed) still fires.
    xfer.onclose!();
    expect(events.at(-1)).toEqual(["p1", "xfer", "closed", undefined]);
  });

  it("(b) xferMessage/xferDrain are gated until the peer is proven (Critical 1 review fix), then fire with peerId", async () => {
    session = new CallSession(ROOM, stream, FAKE_CRYPTO, "ws://test/ws");
    const messages: [string, string | ArrayBuffer][] = [];
    const drains: string[] = [];
    const rosters: RemotePeer[][] = [];
    session.events.on("xferMessage", (peerId, data) => messages.push([peerId, data]));
    session.events.on("xferDrain", (peerId) => drains.push(peerId));
    session.events.on("roster", (r) => rosters.push(r));
    const { pc, xfer } = buildLiveLink();
    xfer.readyState = "open";

    // Before proof: an impostor's xfr/* traffic must never reach the app —
    // this is exactly the hole Critical 1 named (useEpisodeExchange would
    // otherwise build a receiver and commit parts off an unproven peerId).
    xfer.onmessage!({ data: "too-early" });
    xfer.onbufferedamountlow!();
    expect(messages).toEqual([]);
    expect(drains).toEqual([]);

    // Drive the REAL join-proof to completion over the real "cos" channel.
    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    cos.onopen!();
    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "p1") ?? false);

    const buf = new ArrayBuffer(4);
    xfer.onmessage!({ data: "hello" });
    xfer.onmessage!({ data: buf });
    xfer.onbufferedamountlow!();

    expect(messages).toEqual([
      ["p1", "hello"],
      ["p1", buf],
    ]);
    expect(drains).toEqual(["p1"]);
  });

  it("(c) sendXferTo/xferBufferedAmount are gated until proven (Critical 1 review fix), then delegate to the mesh", async () => {
    session = new CallSession(ROOM, stream, FAKE_CRYPTO, "ws://test/ws");
    const rosters: RemotePeer[][] = [];
    session.events.on("roster", (r) => rosters.push(r));
    const { pc, xfer } = buildLiveLink();

    expect(session.sendXferTo("p1", "x")).toBe(false); // not open yet — refused, not queued

    xfer.readyState = "open";
    // Channel is physically open but the peer is still unproven — must still
    // refuse, not fall through to the now-open real channel (Critical 1).
    expect(session.sendXferTo("p1", "x")).toBe(false);
    expect(xfer.sent).toEqual([]);

    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    cos.onopen!();
    await waitFor(() => rosters.at(-1)?.some((p) => p.peerId === "p1") ?? false);

    expect(session.sendXferTo("p1", "x")).toBe(true);
    const buf = new ArrayBuffer(8);
    expect(session.sendXferTo("p1", buf)).toBe(true);
    expect(xfer.sent).toEqual(["x", buf]);

    xfer.bufferedAmount = 4096;
    expect(session.xferBufferedAmount("p1")).toBe(4096);

    expect(session.sendXferTo("ghost", "x")).toBe(false);
    expect(session.xferBufferedAmount("ghost")).toBe(-1);
  });
});

describe("useCallSession bus.xfer", () => {
  function drive(active: boolean) {
    return renderHook(({ active }) => useCallSession(ROOM_KEYS, stream, active), {
      initialProps: { active },
    });
  }

  it("(d) bus.xfer identity is stable across rerenders, before and after a session exists", () => {
    const h = drive(false);
    const xfer0 = h.result.current.bus.xfer;

    h.rerender({ active: false });
    expect(h.result.current.bus.xfer).toBe(xfer0);

    act(() => {
      h.rerender({ active: true });
    });
    expect(h.result.current.bus.xfer).toBe(xfer0);

    h.unmount();
  });

  it("(d) a listener registered before any session exists still receives events once the session emits — gated until proven (Critical 1), unsubscribe stops delivery", async () => {
    const h = drive(false);
    const received: [string, string | ArrayBuffer][] = [];
    const off = h.result.current.bus.xfer.onMessage((peerId, data) => received.push([peerId, data]));

    // Phase 5D: the hook derives its crypto keys asynchronously before
    // constructing the session — await act(async) to flush that microtask
    // (the mocked deriveRoomKeys above) before any session/WS exists.
    await act(async () => {
      h.rerender({ active: true });
    });
    const ws = lastWS();
    act(() => ws.open());
    act(() => enterWithOnePeer(ws));
    act(() => vi.advanceTimersByTime(STAGGER_MS));
    const pc = FakePC.instances.at(-1)!;
    const xfer = xferChannelOf(pc);
    xfer.readyState = "open";

    // Before proof: gated, not merely "no listener wired yet" (Critical 1).
    act(() => xfer.onmessage!({ data: "too-early" }));
    expect(received).toEqual([]);

    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    await act(async () => {
      cos.onopen!();
    });
    await waitFor(() => h.result.current.peers.some((p) => p.peerId === "p1"));

    act(() => xfer.onmessage!({ data: "hi" }));
    expect(received).toEqual([["p1", "hi"]]);

    off();
    act(() => xfer.onmessage!({ data: "again" }));
    expect(received).toEqual([["p1", "hi"]]); // unchanged after unsubscribe

    h.unmount();
  });

  it("(d) bus.xfer.onDrain/onChannelState route through the session; send/bufferedAmount gated until proven (Critical 1), then delegate", async () => {
    const h = drive(true);
    // Phase 5D: flush the async key-derivation microtask before the session
    // (and its WebSocket) exists — see the previous test's comment.
    await act(async () => {});
    const ws = lastWS();
    act(() => ws.open());
    act(() => enterWithOnePeer(ws));
    act(() => vi.advanceTimersByTime(STAGGER_MS));
    const pc = FakePC.instances.at(-1)!;
    const xfer = xferChannelOf(pc);

    const drains: string[] = [];
    const states: [string, ChannelName, ChannelLifecycle][] = [];
    h.result.current.bus.xfer.onDrain((peerId) => drains.push(peerId));
    h.result.current.bus.xfer.onChannelState((peerId, channel, state) => states.push([peerId, channel, state]));

    act(() => xfer.onopen!());
    expect(states).toEqual([]); // channel lifecycle is proof-gated too (Minor 2 review fix)

    xfer.bufferedAmount = 777;
    act(() => xfer.onbufferedamountlow!()); // still unproven — drain gated
    expect(drains).toEqual([]);
    expect(h.result.current.bus.xfer.send("p1", "x")).toBe(false); // unproven — refused

    const cos = cosChannelOf(pc);
    wireHonestPeer(FAKE_CRYPTO.keys.proofKey, cos);
    await act(async () => {
      cos.onopen!();
    });
    await waitFor(() => h.result.current.peers.some((p) => p.peerId === "p1"));

    // Replayed on proven, through the hook's own bus fan-out — this is the
    // event useEpisodeExchange turns into canSend, so losing it would wedge
    // "Send Episode" shut for the whole call.
    expect(states).toEqual([
      ["p1", "cos", "open"],
      ["p1", "xfer", "open"],
    ]);

    act(() => xfer.onbufferedamountlow!());
    expect(drains).toEqual(["p1"]);

    expect(h.result.current.bus.xfer.bufferedAmount("p1")).toBe(777);
    xfer.readyState = "open";
    expect(h.result.current.bus.xfer.send("p1", "x")).toBe(true);
    expect(xfer.sent).toEqual(["x"]);

    expect(h.result.current.bus.xfer.send("ghost", "x")).toBe(false);
    expect(h.result.current.bus.xfer.bufferedAmount("ghost")).toBe(-1);

    h.unmount();
  });
});
