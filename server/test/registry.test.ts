import { describe, expect, it } from "vitest";
import { EMPTY_ROOM_GRACE_MS, MAX_PEERS, RoomRegistry } from "../src/rooms/registry.js";

const ROOM = "R".repeat(22);
const T0 = 1_000_000;

function pairRoom() {
  const reg = new RoomRegistry<string>();
  const created = reg.create(ROOM, "sockA");
  if (created === "room-exists") throw new Error("unreachable");
  const joined = reg.join(ROOM, "sockB");
  if (typeof joined === "string") throw new Error("unreachable");
  return { reg, aId: created.selfId, bId: joined.selfId };
}

describe("RoomRegistry", () => {
  it("creates a room with the creator as its first peer, atomically", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    expect(created.selfId).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(reg.roomCount()).toBe(1);
    expect(reg.get(ROOM, created.selfId)).toBe("sockA");
  });

  it("refuses duplicate create", () => {
    const reg = new RoomRegistry<string>();
    reg.create(ROOM, "sockA");
    expect(reg.create(ROOM, "sockB")).toBe("room-exists");
  });

  it("join returns the existing roster and registers the joiner", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    const joined = reg.join(ROOM, "sockB");
    if (typeof joined === "string") throw new Error("unreachable");
    expect(joined.peers).toEqual([{ peerId: created.selfId, handle: "sockA" }]);
    expect(reg.peersOf(ROOM, joined.selfId)).toEqual([{ peerId: created.selfId, handle: "sockA" }]);
  });

  it("join of an unknown room is refused and never auto-creates", () => {
    const reg = new RoomRegistry<string>();
    expect(reg.join(ROOM, "sockX")).toBe("room-not-found");
    expect(reg.roomCount()).toBe(0);
  });

  it("leave returns the remaining peers to notify", () => {
    const { reg, aId, bId } = pairRoom();
    expect(reg.leave(ROOM, bId, T0)).toEqual([{ peerId: aId, handle: "sockA" }]);
  });

  function meshRoom() {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    const ids: string[] = [created.selfId];
    for (const sock of ["sockB", "sockC", "sockD"]) {
      const joined = reg.join(ROOM, sock);
      if (typeof joined === "string") throw new Error("unreachable");
      ids.push(joined.selfId);
    }
    return { reg, ids: ids as [string, string, string, string] };
  }

  it("seats four and refuses the fifth (Phase 4B)", () => {
    expect(MAX_PEERS).toBe(4);
    const { reg } = meshRoom();
    expect(reg.join(ROOM, "sockE")).toBe("room-full");
  });

  it("each joiner receives the full roster present at join time", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    const b = reg.join(ROOM, "sockB");
    const c = reg.join(ROOM, "sockC");
    const d = reg.join(ROOM, "sockD");
    if (typeof b === "string" || typeof c === "string" || typeof d === "string")
      throw new Error("unreachable");
    expect(b.peers.map((p) => p.handle)).toEqual(["sockA"]);
    expect(c.peers.map((p) => p.handle)).toEqual(["sockA", "sockB"]);
    expect(d.peers.map((p) => p.handle)).toEqual(["sockA", "sockB", "sockC"]);
  });

  it("creator-first leave keeps the room alive and frees the seat", () => {
    const { reg, ids } = meshRoom();
    const remaining = reg.leave(ROOM, ids[0], T0);
    expect(remaining.map((p) => p.peerId)).toEqual(ids.slice(1));
    expect(reg.roomCount()).toBe(1);
    expect(typeof reg.join(ROOM, "sockE")).not.toBe("string"); // seat freed
  });

  it("middle leave then rejoin refills the freed seat", () => {
    const { reg, ids } = meshRoom();
    reg.leave(ROOM, ids[2], T0);
    const rejoin = reg.join(ROOM, "sockC2");
    if (typeof rejoin === "string") throw new Error("unreachable");
    expect(rejoin.peers).toHaveLength(3);
    expect(reg.join(ROOM, "sockF")).toBe("room-full");
  });

  it("an empty room survives inside the grace window and dies after it", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    reg.leave(ROOM, created.selfId, T0);
    reg.sweep(T0 + EMPTY_ROOM_GRACE_MS - 1_000); // 29s empty
    expect(reg.roomCount()).toBe(1);
    reg.sweep(T0 + EMPTY_ROOM_GRACE_MS + 1_000); // 31s empty
    expect(reg.roomCount()).toBe(0);
    expect(reg.join(ROOM, "sockB")).toBe("room-not-found");
  });

  it("a join during the grace window revives the room for good", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    reg.leave(ROOM, created.selfId, T0);
    const rejoined = reg.join(ROOM, "sockA2");
    expect(typeof rejoined).not.toBe("string");
    reg.sweep(T0 + EMPTY_ROOM_GRACE_MS * 10); // long after — occupied rooms never sweep
    expect(reg.roomCount()).toBe(1);
  });

  it("leave of an unknown peer never refreshes the grace timer", () => {
    const reg = new RoomRegistry<string>();
    const created = reg.create(ROOM, "sockA");
    if (created === "room-exists") throw new Error("unreachable");
    reg.leave(ROOM, created.selfId, T0);
    reg.leave(ROOM, "not-a-peer", T0 + 20_000); // stray duplicate close
    reg.sweep(T0 + EMPTY_ROOM_GRACE_MS + 1_000);
    expect(reg.roomCount()).toBe(0); // grace measured from the REAL leave
  });
});
