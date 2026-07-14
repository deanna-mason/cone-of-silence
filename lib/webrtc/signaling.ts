// lib/webrtc/signaling.ts
// Reconnecting signaling client (React-free). Entry is join-first,
// create-on-miss: always try `join`; on room-not-found present the creation
// token if we hold one. Exponential-backoff reconnect (the server's 30s
// empty-room grace makes a quick blip rejoin the same room) until stop() or
// a terminal refusal.

import { Emitter } from "./emitter";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ErrorReason,
  type PeerInfo,
} from "./protocol";

export interface EntryInfo {
  selfId: string;
  peers: PeerInfo[];
}

export type SignalingEventMap = {
  entered: [EntryInfo];
  peerJoined: [peerId: string];
  peerLeft: [peerId: string];
  relay: [from: string, payload: string];
  reconnecting: [];
  refused: [reason: ErrorReason];
};

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export class SignalingClient {
  readonly events = new Emitter<SignalingEventMap>();
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

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
          this.events.emit("entered", { selfId: msg.selfId, peers: [] });
          return;
        case "joined":
          this.attempt = 0;
          this.events.emit("entered", { selfId: msg.selfId, peers: msg.peers });
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
          this.stopped = true; // terminal — reconnecting can't fix a refusal
          ws.close();
          this.events.emit("refused", msg.reason);
          return;
        }
      }
    };

    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
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
