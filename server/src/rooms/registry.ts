// Pure in-memory room registry — no sockets, no timers; callers inject `now`
// so the grace-period logic is unit-testable. Generic over the connection
// handle so tests can use plain strings where production uses WebSockets.

import { randomBytes } from "node:crypto";

export const MAX_PEERS = 2; // Phase 4 raises this to 4 when the mesh manager exists
export const EMPTY_ROOM_GRACE_MS = 30_000;

export type JoinRefusal = "room-not-found" | "room-full";

export interface PeerEntry<T> {
  peerId: string;
  handle: T;
}

interface Room<T> {
  peers: Map<string, T>;
  emptySince: number | null;
}

function newPeerId(): string {
  return randomBytes(6).toString("base64url"); // 6 bytes → exactly 8 chars
}

export class RoomRegistry<T> {
  private rooms = new Map<string, Room<T>>();

  create(roomId: string, handle: T): { selfId: string } | "room-exists" {
    if (this.rooms.has(roomId)) return "room-exists";
    const selfId = newPeerId();
    this.rooms.set(roomId, { peers: new Map([[selfId, handle]]), emptySince: null });
    return { selfId };
  }

  join(roomId: string, handle: T): { selfId: string; peers: PeerEntry<T>[] } | JoinRefusal {
    const room = this.rooms.get(roomId);
    if (!room) return "room-not-found";
    if (room.peers.size >= MAX_PEERS) return "room-full";
    const peers = [...room.peers].map(([peerId, h]) => ({ peerId, handle: h }));
    const selfId = newPeerId();
    room.peers.set(selfId, handle);
    room.emptySince = null;
    return { selfId, peers };
  }

  /** Removes the peer; returns the peers remaining in the room (to notify). */
  leave(roomId: string, peerId: string, now: number): PeerEntry<T>[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const removed = room.peers.delete(peerId);
    if (removed && room.peers.size === 0) room.emptySince = now;
    return [...room.peers].map(([id, handle]) => ({ peerId: id, handle }));
  }

  get(roomId: string, peerId: string): T | undefined {
    return this.rooms.get(roomId)?.peers.get(peerId);
  }

  peersOf(roomId: string, exclude?: string): PeerEntry<T>[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.peers]
      .filter(([id]) => id !== exclude)
      .map(([peerId, handle]) => ({ peerId, handle }));
  }

  sweep(now: number): void {
    for (const [roomId, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
        this.rooms.delete(roomId);
      }
    }
  }

  roomCount(): number {
    return this.rooms.size;
  }
}
