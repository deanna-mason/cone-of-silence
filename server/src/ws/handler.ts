// Socket-agnostic signaling logic: validates messages, gates creation on the
// Phase 2.5 TokenStore, and routes through the pure RoomRegistry. Knows
// nothing about the `ws` package — Task 4's attach.ts adapts real sockets,
// tests use fakes.

import { StoreUnavailableError, type TokenStore, type VerifyResult } from "../tokens/types.js";
import { RoomRegistry } from "../rooms/registry.js";
import {
  parseClientMessage,
  type ErrorReason,
  type ServerMessage,
} from "../../../lib/webrtc/protocol.js";

export interface SignalSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const REFUSAL_COPY: Record<ErrorReason, string> = {
  "room-not-found": "This corridor is dark — the channel was struck or never opened.",
  "room-full": "The cone seats two. This channel is at capacity.",
  "create-refused": "Clearance not recognized. No channel was opened.",
  "bad-message": "Garbled transmission. Line closed.",
};

interface ConnState {
  roomId: string;
  peerId: string;
}

export class SignalingHandler {
  private conns = new Map<SignalSocket, ConnState>();

  constructor(
    private readonly store: TokenStore,
    readonly registry: RoomRegistry<SignalSocket> = new RoomRegistry(),
    private readonly clock: () => number = Date.now,
  ) {}

  async onMessage(sock: SignalSocket, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.refuse(sock, "bad-message", true);
      return;
    }
    const state = this.conns.get(sock);
    if (!state) {
      if (msg.t === "create") {
        await this.handleCreate(sock, msg.roomId, msg.token);
      } else if (msg.t === "join") {
        this.handleJoin(sock, msg.roomId);
      } else {
        this.refuse(sock, "bad-message", true); // relay/leave before entering a room
      }
      return;
    }
    if (msg.t === "relay") {
      const target = this.registry.get(state.roomId, msg.to);
      // unknown target is a normal race (peer just left) — drop silently
      if (target && target !== sock) {
        this.deliver(target, { v: 1, t: "relay", from: state.peerId, payload: msg.payload });
      }
      return;
    }
    if (msg.t === "leave") {
      this.onClose(sock);
      sock.close();
      return;
    }
    this.refuse(sock, "bad-message", true); // create/join while already in a room
  }

  /** Runs on graceful leave AND abrupt socket close — the single leave path. */
  onClose(sock: SignalSocket): void {
    const state = this.conns.get(sock);
    if (!state) return;
    this.conns.delete(sock);
    for (const { handle } of this.registry.leave(state.roomId, state.peerId, this.clock())) {
      this.deliver(handle, { v: 1, t: "peer-left", peerId: state.peerId });
    }
  }

  sweep(): void {
    this.registry.sweep(this.clock());
  }

  private async handleCreate(sock: SignalSocket, roomId: string, token: string): Promise<void> {
    let verdict: VerifyResult;
    try {
      verdict = await this.store.verify(token); // touch defaults true — creation is a real use
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        this.refuse(sock, "create-refused"); // fail CLOSED
        return;
      }
      throw err;
    }
    if (!verdict.ok) {
      this.refuse(sock, "create-refused");
      return;
    }
    // The verify await yields the event loop: if another message won this
    // socket a room slot meanwhile, a second entry would double-register it.
    if (this.conns.has(sock)) {
      this.refuse(sock, "bad-message", true); // closing runs onClose → clean leave
      return;
    }
    const result = this.registry.create(roomId, sock);
    if (result === "room-exists") {
      this.handleJoin(sock, roomId); // join-first flow: a create race folds into join
      return;
    }
    this.conns.set(sock, { roomId, peerId: result.selfId });
    this.deliver(sock, { v: 1, t: "created", selfId: result.selfId });
  }

  private handleJoin(sock: SignalSocket, roomId: string): void {
    const result = this.registry.join(roomId, sock);
    if (result === "room-not-found" || result === "room-full") {
      this.refuse(sock, result); // NOT closed — the client may follow up with create
      return;
    }
    this.conns.set(sock, { roomId, peerId: result.selfId });
    this.deliver(sock, {
      v: 1, t: "joined", selfId: result.selfId,
      peers: result.peers.map((p) => ({ peerId: p.peerId })),
    });
    for (const { handle } of this.registry.peersOf(roomId, result.selfId)) {
      this.deliver(handle, { v: 1, t: "peer-joined", peerId: result.selfId });
    }
  }

  private refuse(sock: SignalSocket, reason: ErrorReason, close = false): void {
    this.deliver(sock, { v: 1, t: "error", reason, message: REFUSAL_COPY[reason] });
    if (close) sock.close();
  }

  private deliver(sock: SignalSocket, msg: ServerMessage): void {
    sock.send(JSON.stringify(msg));
  }
}
