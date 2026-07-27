// lib/webrtc/signaling.ts
// Reconnecting signaling client (React-free). Entry is join-first,
// create-on-miss: always try `join`; on room-not-found present the creation
// token if we hold one. Exponential-backoff reconnect until stop() or a
// terminal refusal.
//
// Phase 4C recovery: once a session has entered a room (`everEntered`),
// refusals during an outage retry on a WALL-CLOCK deadline from the moment
// the socket was lost — not an attempt budget. A ~90s server reboot burns
// any attempt counter on connection failures alone before the server can
// even answer (the shipped Phase-2 bug this replaces). room-full during the
// window is usually our own ghost awaiting the heartbeat sweep;
// room-not-found is the server rebooting out from under the room (the
// creator's create-on-miss resurrects it). Cold visitors still fail fast.

import { Emitter } from "./emitter";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ErrorReason,
  type IceServer,
  type PeerInfo,
} from "./protocol";

export interface EntryInfo {
  selfId: string;
  peers: PeerInfo[];
  ice?: IceServer[];
}

export type SignalingEventMap = {
  entered: [EntryInfo];
  peerJoined: [peerId: string];
  peerLeft: [peerId: string];
  relay: [from: string, payload: string];
  reconnecting: [];
  /** afterEntry: this client had entered the room before the refusal —
   *  lets the UI distinguish "recovery exhausted" from a cold failure. */
  refused: [reason: ErrorReason, afterEntry: boolean];
};

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** Recovery window measured from socket loss — sized to ride out a full box
 *  reboot (~90s observed in the 3A reboot drill) plus the ghost sweep. */
export const RETRY_DEADLINE_MS = 90_000;

export class SignalingClient {
  readonly events = new Emitter<SignalingEventMap>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private everEntered = false;
  /** Wall-clock start of the current outage; null while connected-and-entered. */
  private outageSince: number | null = null;

  constructor(
    private readonly url: string,
    private readonly roomId: string,
    private readonly getCreateToken: () => string | null,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  sendRelay(to: string, payload: string): void {
    this.send({ v: PROTOCOL_VERSION, t: "relay", to, payload });
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private withinRecoveryWindow(): boolean {
    return (
      this.everEntered &&
      this.outageSince !== null &&
      Date.now() - this.outageSince <= RETRY_DEADLINE_MS
    );
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let triedCreate = false;

    ws.onopen = () => this.send({ v: PROTOCOL_VERSION, t: "join", roomId: this.roomId });

    ws.onmessage = (ev) => {
      const msg = parseServerMessage(String(ev.data));
      if (!msg) return;
      switch (msg.t) {
        case "created":
          this.attempt = 0;
          this.everEntered = true;
          this.outageSince = null;
          this.events.emit("entered", { selfId: msg.selfId, peers: [], ice: msg.ice });
          return;
        case "joined":
          this.attempt = 0;
          this.everEntered = true;
          this.outageSince = null;
          this.events.emit("entered", { selfId: msg.selfId, peers: msg.peers, ice: msg.ice });
          return;
        case "peer-joined":
          this.events.emit("peerJoined", msg.peerId);
          return;
        case "peer-left":
          this.events.emit("peerLeft", msg.peerId);
          return;
        case "relay":
          this.events.emit("relay", msg.from, msg.payload);
          return;
        case "error": {
          if (msg.reason === "room-not-found" && !triedCreate) {
            const token = this.getCreateToken();
            if (token) {
              triedCreate = true; // one shot per connection
              this.send({ v: PROTOCOL_VERSION, t: "create", roomId: this.roomId, token });
              return;
            }
          }
          if (
            (msg.reason === "room-full" || msg.reason === "room-not-found") &&
            this.withinRecoveryWindow()
          ) {
            ws.close(); // onclose path schedules the next backoff attempt
            return;
          }
          this.stopped = true; // terminal — reconnecting can't fix this refusal
          ws.close();
          this.events.emit("refused", msg.reason, this.everEntered);
          return;
        }
      }
    };

    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      if (this.outageSince === null) this.outageSince = Date.now();
      this.events.emit("reconnecting");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const base = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    const delay = base * (0.5 + Math.random()); // jitter
    this.attempt += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
