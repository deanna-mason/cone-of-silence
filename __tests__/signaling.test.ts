// SignalingClient recovery semantics (Phase 4C). First-ever coverage of this
// class — fake WebSocket + fake timers; no network, no sleeps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETRY_DEADLINE_MS, SignalingClient } from "@/lib/webrtc/signaling";
import type { ErrorReason } from "@/lib/webrtc/protocol";

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
  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSays(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(): void {
    this.close();
  }
}

const ROOM = "R".repeat(22);
let client: SignalingClient;
let refusals: [ErrorReason, boolean][];
let entered: number;
let token: string | null;

function lastWS(): FakeWS {
  return FakeWS.instances.at(-1)!;
}

/** Open the newest socket and let the client send its join. */
function openAndJoin(): FakeWS {
  const ws = lastWS();
  ws.open();
  return ws;
}

function enterRoom(): FakeWS {
  client.start();
  const ws = openAndJoin();
  ws.serverSays({ v: 1, t: "joined", selfId: "me", peers: [] });
  return ws;
}

/** Advance fake timers until a new socket appears, bounded so a
 *  terminal-latch regression fails the test instead of spinning the
 *  runner forever (vitest's testTimeout can't fire through a sync loop). */
function advanceUntilNextSocket(count: number): void {
  for (let i = 0; i < 200 && FakeWS.instances.length === count; i++) vi.advanceTimersByTime(1_000);
  if (FakeWS.instances.length === count) throw new Error("no reconnect socket — client went terminal");
}

/** Advance through backoff to the client's next socket, then open+join it.
 *  A prior advanceTimersByTime may already have fired the reconnect timer,
 *  leaving an unopened socket waiting — use it instead of spinning forever. */
function nextAttempt(): FakeWS {
  if (lastWS().readyState === 0) return openAndJoin();
  advanceUntilNextSocket(FakeWS.instances.length);
  return openAndJoin();
}

beforeEach(() => {
  // Date must be faked too — the recovery window reads Date.now(); and the
  // jitter is pinned to its midpoint so backoff sums are deterministic
  // (12 refusal rounds = 85.5s virtual, safely inside the 90s window).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeWS.instances = [];
  refusals = [];
  entered = 0;
  token = null;
  vi.stubGlobal("WebSocket", FakeWS);
  client = new SignalingClient("ws://test/ws", ROOM, () => token);
  client.events.on("entered", () => entered++);
  client.events.on("refused", (reason, afterEntry) => refusals.push([reason, afterEntry]));
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("entry", () => {
  it("joins on open and emits entered", () => {
    enterRoom();
    expect(JSON.parse(lastWS().sent[0])).toMatchObject({ t: "join", roomId: ROOM });
    expect(entered).toBe(1);
  });

  it("create-on-miss is one shot per connection and only with a token", () => {
    token = "t".repeat(22);
    client.start();
    const ws = openAndJoin();
    ws.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(JSON.parse(ws.sent[1])).toMatchObject({ t: "create", token });
    ws.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(ws.sent).toHaveLength(2); // no second create — terminal path
    expect(refusals).toEqual([["room-not-found", false]]);
  });
});

describe("everEntered gate", () => {
  it("a cold visitor's room-not-found is terminal immediately (no token)", () => {
    client.start();
    const ws = openAndJoin();
    ws.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(refusals).toEqual([["room-not-found", false]]);
  });

  it("post-entry room-not-found during an outage retries instead of dying", () => {
    enterRoom().drop(); // outage clock starts
    const ws2 = nextAttempt();
    ws2.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(refusals).toEqual([]); // not terminal — retrying
    const ws3 = nextAttempt();
    ws3.serverSays({ v: 1, t: "joined", selfId: "me2", peers: [] });
    expect(entered).toBe(2); // recovered
  });
});

describe("wall-clock deadline (replaces the attempt budget)", () => {
  it("room-full keeps retrying well past 8 attempts inside the window", () => {
    enterRoom().drop();
    for (let i = 0; i < 12; i++) {
      const ws = nextAttempt();
      ws.serverSays({ v: 1, t: "error", reason: "room-full", message: "" });
      expect(refusals).toEqual([]);
    }
  });

  it("goes terminal with afterEntry=true once the deadline passes", () => {
    enterRoom().drop();
    vi.advanceTimersByTime(RETRY_DEADLINE_MS + 1_000);
    const ws = nextAttempt();
    ws.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    expect(refusals).toEqual([["room-not-found", true]]);
  });

  it("a successful re-entry resets the outage clock", () => {
    enterRoom().drop();
    vi.advanceTimersByTime(60_000);
    const ws2 = nextAttempt();
    ws2.serverSays({ v: 1, t: "joined", selfId: "me2", peers: [] });
    lastWS().drop(); // NEW outage — fresh 90s window
    vi.advanceTimersByTime(60_000); // old clock would have expired by now
    const ws3 = nextAttempt();
    ws3.serverSays({ v: 1, t: "error", reason: "room-full", message: "" });
    expect(refusals).toEqual([]); // still inside the fresh window
  });

  it("pure connect failures never consume the recovery window's patience", () => {
    // This is the shipped Phase-2 bug, pinned: with jitter fixed at its
    // midpoint (factor 1.0), the 10 unopened-drop rounds below fire at
    // attempts 0-9 — delays 500,1000,2000,4000,8000,then capped at 10000 for
    // the remaining 5 — polled in 1s ticks (the 500ms round rounds up to a
    // 1000ms tick). Summed: 1000+1000+2000+4000+8000+10000*5 = 66000ms. The
    // final successful attempt (attempt 10, also capped) adds another
    // 10000ms = 76000ms total — comfortably inside RETRY_DEADLINE_MS
    // (90000ms), with >10s of headroom to spare.
    enterRoom().drop();
    for (let i = 0; i < 10; i++) {
      // socket comes up but the server is still down — it dies unopened
      const count = FakeWS.instances.length;
      advanceUntilNextSocket(count);
      lastWS().drop();
    }
    const ws = nextAttempt(); // server finally back
    ws.serverSays({ v: 1, t: "error", reason: "room-full", message: "" });
    expect(refusals).toEqual([]); // old attempt-budget code would be terminal by now
  });
});

describe("unchanged terminal paths", () => {
  it("create-refused is always terminal, even post-entry", () => {
    token = "t".repeat(22);
    enterRoom().drop();
    const ws = nextAttempt();
    ws.serverSays({ v: 1, t: "error", reason: "room-not-found", message: "" });
    ws.serverSays({ v: 1, t: "error", reason: "create-refused", message: "" });
    expect(refusals).toEqual([["create-refused", true]]);
  });
});

// The 2026-08-03 two-Mac drill: a ~20s wifi loss on one Mac never healed.
// Proxy-blackhole repro proved a silently-dead socket keeps readyState OPEN
// forever — the browser auto-pongs the server's protocol pings invisibly,
// an idle call never sends, so NOTHING notices the socket is gone (while the
// same outage delivered as an RST heals in seconds). The OS's own
// offline/online events are the client's only reliable network-loss signal.
describe("network liveness events", () => {
  it("'offline' proactively closes an open socket — recovery machinery engages instead of a zombie", () => {
    let reconnecting = 0;
    client.events.on("reconnecting", () => reconnecting++);
    enterRoom();
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("offline"));

    expect(lastWS().readyState).toBe(3);
    expect(reconnecting).toBe(1);
    advanceUntilNextSocket(count); // a retry is scheduled, not a dead end
  });

  it("'online' fires a pending backoff retry immediately", () => {
    enterRoom().drop();
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("online"));

    // No timer advance: the reconnect attempt must be synchronous with the
    // event — the whole point is not waiting out a 10s backoff ceiling
    // after the network just came back.
    expect(FakeWS.instances.length).toBe(count + 1);
    const ws = openAndJoin();
    ws.serverSays({ v: 1, t: "joined", selfId: "me2", peers: [] });
    expect(entered).toBe(2);
  });

  it("'online' with a socket still reporting OPEN treats it as suspect and closes it", () => {
    // No 'offline' ever fired (silent path death, then a network change) —
    // the held socket may be a zombie. Closing it costs one rejoin cycle
    // if it was healthy; keeping it costs the call forever if it wasn't.
    enterRoom();
    const ws = lastWS();
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("online"));

    expect(ws.readyState).toBe(3);
    advanceUntilNextSocket(count);
  });

  it("stop() removes the listeners — no reconnect activity from later events", () => {
    enterRoom();
    client.stop();
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));

    expect(FakeWS.instances.length).toBe(count);
  });
});

// close() on a DEAD path stalls in the CLOSING handshake — Chrome waits ~60s
// for a close reply that can never arrive (observed in the proxy repro:
// readyState sat at 2 the whole outage; recovery began a minute late). The
// event handlers must detach and drive recovery themselves, never wait for
// onclose; the ws-identity guard makes the eventual late onclose a no-op.
describe("network liveness events x stalled close handshake", () => {
  function stall(ws: FakeWS): void {
    ws.close = () => {
      ws.readyState = 2; // CLOSING forever — no onclose
    };
  }

  it("'offline' drives recovery immediately even when close() stalls", () => {
    let reconnecting = 0;
    client.events.on("reconnecting", () => reconnecting++);
    const ws = enterRoom();
    stall(ws);
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("offline"));

    expect(reconnecting).toBe(1);
    advanceUntilNextSocket(count); // retry scheduled without waiting for onclose
  });

  it("'online' against a stalled-CLOSING socket reconnects immediately", () => {
    const ws = enterRoom();
    stall(ws);
    window.dispatchEvent(new Event("offline")); // enters recovery, socket stuck CLOSING
    // burn the scheduled retry so no timer is pending, then simulate the
    // network returning while the old socket still reports CLOSING
    const count0 = FakeWS.instances.length;
    advanceUntilNextSocket(count0);
    lastWS().drop(); // that retry fails too (still offline)
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("online"));

    expect(FakeWS.instances.length).toBe(count + 1); // synchronous reconnect
    const fresh = openAndJoin();
    fresh.serverSays({ v: 1, t: "joined", selfId: "me2", peers: [] });
    expect(entered).toBe(2);
  });

  it("a late onclose from the detached socket never double-schedules", () => {
    let reconnecting = 0;
    client.events.on("reconnecting", () => reconnecting++);
    const ws = enterRoom();
    stall(ws);
    const count = FakeWS.instances.length;

    window.dispatchEvent(new Event("offline"));
    // the stalled handshake finally times out much later
    ws.readyState = 3;
    ws.onclose?.();

    expect(reconnecting).toBe(1); // not 2
    advanceUntilNextSocket(count);
    expect(FakeWS.instances.length).toBe(count + 1); // exactly one retry in flight
  });
});
