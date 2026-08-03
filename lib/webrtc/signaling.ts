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
    if (typeof window !== "undefined") {
      window.addEventListener("offline", this.onOffline);
      window.addEventListener("online", this.onOnline);
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("offline", this.onOffline);
      window.removeEventListener("online", this.onOnline);
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
  }

  /** Detach the current socket and enter recovery WITHOUT waiting for its
   *  close event: close() on a dead path stalls in the CLOSING handshake
   *  (~60s in Chrome — observed in the 2026-08-03 proxy repro), and a
   *  silently-dead socket may never fire close at all. The onclose
   *  identity guard (`this.ws !== ws`) turns the detached socket's
   *  eventual close into a no-op, so recovery is driven exactly once. */
  private detachAndAbandon(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close(); // best effort — may stall; nothing waits on it
    if (this.outageSince === null) this.outageSince = Date.now();
    this.events.emit("reconnecting");
  }

  /** The OS says the network is gone. A silently-dead socket often never
   *  fires close on its own — the server's protocol pings are auto-ponged
   *  by the browser below JS, and an idle call sends nothing, so a dead
   *  path can hold readyState OPEN forever (observed live 2026-08-03: a
   *  ~20s wifi loss left a zombie socket and the call never healed, while
   *  the same outage delivered as an RST healed in seconds). Hand the
   *  outage to the proven backoff → rejoin machinery now, honest banner
   *  and all. */
  private readonly onOffline = (): void => {
    if (this.stopped || this.timer !== null) return; // already recovering
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    this.detachAndAbandon();
    this.scheduleReconnect();
  };

  /** Network is back (or changed). A pending backoff retry fires NOW —
   *  waiting out a 10s ceiling after the network just returned is pure
   *  lag. With no retry pending but a socket still reporting OPEN or
   *  CLOSING, the socket is suspect: whatever transition fired this event
   *  likely killed the old path (a silent death never fired 'offline';
   *  a stalled close handshake can hold CLOSING for a minute). Abandoning
   *  it costs one quick rejoin cycle if it was healthy; keeping a zombie
   *  costs the call forever. */
  private readonly onOnline = (): void => {
    if (this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.attempt = 0;
      this.connect();
      return;
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    this.detachAndAbandon();
    this.attempt = 0;
    this.connect();
  };

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
