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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { CallSession, type ChannelLifecycle, type ChannelName } from "@/lib/webrtc/session";
import { useCallSession } from "@/hooks/useCallSession";
import { STAGGER_MS } from "@/lib/webrtc/mesh";

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

// connectionState is not modeled (onconnectionstatechange stored, never
// invoked) — same scope limit as session.test.ts's FakePC; irrelevant here.
class FakePC {
  static instances: FakePC[] = [];
  config: RTCConfiguration | undefined;
  addedTracks: MediaStreamTrack[] = [];
  channels: FakeChannel[] = [];
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
  }
  getSenders() {
    return [];
  }
  restartIce() {}
  close() {
    this.closed = true;
  }
}

const ROOM = "r".repeat(22);
const track = { kind: "video" } as MediaStreamTrack;
const stream = { getTracks: () => [track] } as unknown as MediaStream;
const ICE_A = [{ urls: "stun:a.example:1" }];

function lastWS(): FakeWS {
  return FakeWS.instances.at(-1)!;
}

function xferChannelOf(pc: FakePC): FakeChannel {
  return pc.channels.find((c) => c.label === "cos-xfer")!;
}

function enterWithOnePeer(ws: FakeWS): void {
  ws.serverSays({ v: 1, t: "joined", selfId: "me", peers: [{ peerId: "p1" }], ice: ICE_A });
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeWS.instances = [];
  FakePC.instances = [];
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("RTCPeerConnection", FakePC);
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

  it("(a) mesh onChannelState -> session channelState event with all four args", () => {
    session = new CallSession(ROOM, stream, "ws://test/ws");
    const events: [string, ChannelName, ChannelLifecycle, string | undefined][] = [];
    session.events.on("channelState", (peerId, channel, state, detail) =>
      events.push([peerId, channel, state, detail]),
    );
    const { xfer } = buildLiveLink();

    xfer.onopen!();
    expect(events).toEqual([["p1", "xfer", "open", undefined]]);

    xfer.onerror!({ error: { message: "sctp reset" } });
    expect(events.at(-1)).toEqual(["p1", "xfer", "error", "sctp reset"]);

    xfer.onclose!();
    expect(events.at(-1)).toEqual(["p1", "xfer", "closed", undefined]);
  });

  it("(b) xferMessage and xferDrain events fire with peerId", () => {
    session = new CallSession(ROOM, stream, "ws://test/ws");
    const messages: [string, string | ArrayBuffer][] = [];
    const drains: string[] = [];
    session.events.on("xferMessage", (peerId, data) => messages.push([peerId, data]));
    session.events.on("xferDrain", (peerId) => drains.push(peerId));
    const { xfer } = buildLiveLink();
    xfer.readyState = "open";

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

  it("(c) sendXferTo/xferBufferedAmount delegate to the mesh", () => {
    session = new CallSession(ROOM, stream, "ws://test/ws");
    const { xfer } = buildLiveLink();

    expect(session.sendXferTo("p1", "x")).toBe(false); // not open yet — refused, not queued
    xfer.readyState = "open";
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
    return renderHook(({ active }) => useCallSession(ROOM, stream, active), {
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

  it("(d) a listener registered before any session exists still receives events once the session emits; unsubscribe stops delivery", () => {
    const h = drive(false);
    const received: [string, string | ArrayBuffer][] = [];
    const off = h.result.current.bus.xfer.onMessage((peerId, data) => received.push([peerId, data]));

    act(() => {
      h.rerender({ active: true });
    });
    const ws = lastWS();
    act(() => ws.open());
    act(() => enterWithOnePeer(ws));
    act(() => vi.advanceTimersByTime(STAGGER_MS));
    const pc = FakePC.instances.at(-1)!;
    const xfer = xferChannelOf(pc);
    xfer.readyState = "open";

    act(() => xfer.onmessage!({ data: "hi" }));
    expect(received).toEqual([["p1", "hi"]]);

    off();
    act(() => xfer.onmessage!({ data: "again" }));
    expect(received).toEqual([["p1", "hi"]]); // unchanged after unsubscribe

    h.unmount();
  });

  it("(d) bus.xfer.onDrain and onChannelState route through the session, and send/bufferedAmount delegate", () => {
    const h = drive(true);
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
    expect(states).toEqual([["p1", "xfer", "open"]]);

    xfer.bufferedAmount = 777;
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
