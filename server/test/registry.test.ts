import { describe, expect, it } from "vitest";
import { EMPTY_ROOM_GRACE_MS, MAX_PEERS, RoomRegistry } from "../src/rooms/registry.js";

const ROOM = "R".repeat(22);
const T0 = 1_000_000;

function fullRoom() {
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

  it("caps the room at MAX_PEERS (2 in Phase 2)", () => {
    expect(MAX_PEERS).toBe(2);
    const { reg } = fullRoom();
    expect(reg.join(ROOM, "sockC")).toBe("room-full");
  });

  it("leave returns the remaining peers to notify", () => {
    const { reg, aId, bId } = fullRoom();
    expect(reg.leave(ROOM, bId, T0)).toEqual([{ peerId: aId, handle: "sockA" }]);
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
});
