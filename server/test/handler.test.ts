import { describe, expect, it } from "vitest";
import { SignalingHandler, type SignalSocket } from "../src/ws/handler.js";
import { StoreUnavailableError, type Grant, type TokenStore } from "../src/tokens/types.js";
import type { ServerMessage } from "../../lib/webrtc/protocol.js";

const ROOM = "R".repeat(22);
const GOOD = "g".repeat(22);
const BAD = "b".repeat(22);
const T0 = 1_000_000;

class FakeSocket implements SignalSocket {
  sent: ServerMessage[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.closed = true;
  }
  last(): ServerMessage | undefined {
    return this.sent.at(-1);
  }
}

const grant: Grant = {
  id: "1", label: "test", createdAt: "2026-07-13T00:00:00Z", lastUsedAt: null, revokedAt: null,
};

function stubStore(verify?: TokenStore["verify"]): TokenStore {
  const unused = () => Promise.reject(new Error("not used by the handler"));
  return {
    verify: verify ?? (async (token) => (token === GOOD ? { ok: true, grant } : { ok: false, reason: "invalid" })),
    mint: unused, list: unused, listEvents: unused, relabel: unused,
    revoke: unused, restore: unused, purge: unused,
  } as unknown as TokenStore;
}

const create = (token = GOOD) => JSON.stringify({ v: 1, t: "create", roomId: ROOM, token });
const join = () => JSON.stringify({ v: 1, t: "join", roomId: ROOM });
const relay = (to: string, payload: string) => JSON.stringify({ v: 1, t: "relay", to, payload });

function idOf(msg: ServerMessage | undefined): string {
  if (msg?.t === "created" || msg?.t === "joined") return msg.selfId;
  throw new Error(`expected created/joined, got ${JSON.stringify(msg)}`);
}

async function callUp() {
  const handler = new SignalingHandler(stubStore(), undefined, () => T0);
  const a = new FakeSocket();
  const b = new FakeSocket();
  await handler.onMessage(a, create());
  await handler.onMessage(b, join());
  return { handler, a, b, aId: idOf(a.sent[0]), bId: idOf(b.sent[0]) };
}

describe("SignalingHandler", () => {
  it("a valid token creates a room and answers `created`", async () => {
    const handler = new SignalingHandler(stubStore());
    const a = new FakeSocket();
    await handler.onMessage(a, create());
    expect(a.last()?.t).toBe("created");
    expect(handler.registry.roomCount()).toBe(1);
  });

  it("an invalid token is refused and NO room is registered; socket stays open", async () => {
    const handler = new SignalingHandler(stubStore());
    const a = new FakeSocket();
    await handler.onMessage(a, create(BAD));
    expect(a.last()).toMatchObject({ t: "error", reason: "create-refused" });
    expect(handler.registry.roomCount()).toBe(0);
    expect(a.closed).toBe(false);
  });

  it("fails CLOSED when the token store is unreachable", async () => {
    const handler = new SignalingHandler(
      stubStore(async () => { throw new StoreUnavailableError("supabase down"); }),
    );
    const a = new FakeSocket();
    await handler.onMessage(a, create());
    expect(a.last()).toMatchObject({ t: "error", reason: "create-refused" });
    expect(handler.registry.roomCount()).toBe(0);
  });

  it("join-first flow works on one socket: join → room-not-found (open) → create succeeds", async () => {
    const handler = new SignalingHandler(stubStore());
    const a = new FakeSocket();
    await handler.onMessage(a, join());
    expect(a.last()).toMatchObject({ t: "error", reason: "room-not-found" });
    expect(a.closed).toBe(false);
    await handler.onMessage(a, create());
    expect(a.last()?.t).toBe("created");
  });

  it("create of an existing room folds into a plain join", async () => {
    const handler = new SignalingHandler(stubStore());
    const first = new FakeSocket();
    const second = new FakeSocket();
    await handler.onMessage(first, create());
    await handler.onMessage(second, create()); // race: room already exists
    expect(second.last()?.t).toBe("joined");
    expect(first.last()).toMatchObject({ t: "peer-joined" });
  });

  it("join returns the roster and broadcasts peer-joined to the room", async () => {
    const { a, b, aId, bId } = await callUp();
    expect(b.sent[0]).toMatchObject({ t: "joined", peers: [{ peerId: aId }] });
    expect(a.sent[1]).toEqual({ v: 1, t: "peer-joined", peerId: bId });
  });

  it("a third joiner is refused with room-full", async () => {
    const { handler } = await callUp();
    const c = new FakeSocket();
    await handler.onMessage(c, join());
    expect(c.last()).toMatchObject({ t: "error", reason: "room-full" });
  });

  it("relay routes the opaque payload only to the addressed peer", async () => {
    const { handler, a, b, aId, bId } = await callUp();
    const payload = JSON.stringify({ description: { type: "offer", sdp: "v=0…" } });
    await handler.onMessage(b, relay(aId, payload));
    expect(a.last()).toEqual({ v: 1, t: "relay", from: bId, payload });
    expect(b.sent.filter((m) => m.t === "relay")).toHaveLength(0);
  });

  it("relay to a departed peer is silently dropped", async () => {
    const { handler, a, b, aId } = await callUp();
    handler.onClose(a);
    const before = b.sent.length;
    await handler.onMessage(b, relay(aId, "late"));
    expect(b.sent.length).toBe(before); // no error message either
  });

  it("garbled JSON gets bad-message and the socket closed", async () => {
    const handler = new SignalingHandler(stubStore());
    const a = new FakeSocket();
    await handler.onMessage(a, "ce n'est pas du JSON");
    expect(a.last()).toMatchObject({ t: "error", reason: "bad-message" });
    expect(a.closed).toBe(true);
  });

  it("join/create on an already-joined socket is bad-message", async () => {
    const { handler, b } = await callUp();
    await handler.onMessage(b, join());
    expect(b.last()).toMatchObject({ t: "error", reason: "bad-message" });
    expect(b.closed).toBe(true);
  });

  it("a second create racing a pending verify cannot double-register the socket", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handler = new SignalingHandler(
      stubStore(async (token) => {
        await gate;
        return token === GOOD ? { ok: true, grant } : { ok: false, reason: "invalid" };
      }),
    );
    const a = new FakeSocket();
    const p1 = handler.onMessage(a, create());
    const p2 = handler.onMessage(a, create()); // both now awaiting verify
    release();
    await Promise.all([p1, p2]);
    // exactly one entry may exist for this socket across the room
    const slots = handler.registry.peersOf(ROOM).filter((p) => p.handle === a);
    expect(slots.length).toBe(1);
    // and the loser was refused as a protocol violation
    expect(a.sent.filter((m) => m.t === "error" && m.reason === "bad-message")).toHaveLength(1);
    expect(a.closed).toBe(true);
  });

  it("leave and abrupt close both broadcast peer-left to the survivors", async () => {
    const { handler, a, b, bId } = await callUp();
    await handler.onMessage(b, JSON.stringify({ v: 1, t: "leave" }));
    expect(a.last()).toEqual({ v: 1, t: "peer-left", peerId: bId });
    expect(b.closed).toBe(true);
    // abrupt close of the survivor empties the room (grace stamped via clock)
    handler.onClose(a);
    handler.sweep();
    expect(handler.registry.roomCount()).toBe(1); // still inside the grace window at T0
  });
});
