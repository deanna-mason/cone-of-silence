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

/** Advance through backoff to the client's next socket, then open+join it.
 *  A prior advanceTimersByTime may already have fired the reconnect timer,
 *  leaving an unopened socket waiting — use it instead of spinning forever. */
function nextAttempt(): FakeWS {
  if (lastWS().readyState === 0) return openAndJoin();
  const count = FakeWS.instances.length;
  while (FakeWS.instances.length === count) vi.advanceTimersByTime(1_000);
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
