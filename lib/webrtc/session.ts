// lib/webrtc/session.ts
// The React-free call orchestrator (spec approach A): owns the signaling
// client and (Phase 2) a single PeerLink, runs the status machine, and emits
// UI-facing events. React renders what this reports; it never drives
// negotiation. Phase 4's mesh manager replaces the single link.

import { readCreateToken } from "../createToken";
import { SIGNALING_URL } from "../config";
import { Emitter } from "./emitter";
import { PeerLink } from "./peer";
import { SignalingClient } from "./signaling";

export type CallStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "room-not-found"
  | "room-full"
  | "create-refused"
  | "signal-lost";

export type CallEventMap = {
  status: [CallStatus];
  remoteStream: [MediaStream | null];
  channelOpen: [];
};

export class CallSession {
  readonly events = new Emitter<CallEventMap>();
  private readonly signaling: SignalingClient;
  private link: PeerLink | null = null;
  private remotePeerId: string | null = null;
  private localStream: MediaStream;
  private currentStatus: CallStatus = "connecting";

  constructor(roomId: string, localStream: MediaStream, url: string = SIGNALING_URL) {
    this.localStream = localStream;
    this.signaling = new SignalingClient(url, roomId, readCreateToken);
    const ev = this.signaling.events;

    ev.on("entered", (info) => {
      const other = info.peers[0]; // MAX_PEERS = 2 → at most one
      if (other) {
        this.connectTo(other.peerId, true); // we are the newcomer → polite
      } else {
        this.setStatus("waiting");
      }
    });
    ev.on("peerJoined", (peerId) => {
      if (!this.link) this.connectTo(peerId, false); // they are the newcomer → we are impolite
    });
    ev.on("peerLeft", (peerId) => {
      if (peerId === this.remotePeerId) this.dropLink("waiting");
    });
    ev.on("relay", (from, payload) => {
      // handleSignal can reject on straggler ICE after an ignored offer —
      // expected negotiation noise, never fatal to the session.
      if (from === this.remotePeerId) this.link?.handleSignal(payload).catch(() => {});
    });
    // Socket lost: keep local media, tear the peer down, rebuild fresh after
    // rejoin (decision Q3-A — no ICE restart until Phase 4).
    ev.on("reconnecting", () => this.dropLink("reconnecting"));
    ev.on("refused", (reason) => {
      this.dropLink(reason === "bad-message" ? "signal-lost" : reason);
    });
  }

  get status(): CallStatus {
    return this.currentStatus;
  }

  start(): void {
    this.signaling.start();
  }

  /** Stops signaling and the peer. Local media belongs to useLocalMedia. */
  leave(): void {
    this.signaling.stop();
    this.link?.close();
    this.link = null;
    this.remotePeerId = null;
  }

  /** Device switch: swap tracks on the live link without renegotiating. */
  async setLocalStream(stream: MediaStream): Promise<void> {
    this.localStream = stream;
    await this.link?.replaceStream(stream);
  }

  private connectTo(peerId: string, polite: boolean): void {
    this.remotePeerId = peerId;
    this.link = new PeerLink({
      polite,
      localStream: this.localStream,
      sendSignal: (payload) => this.signaling.sendRelay(peerId, payload),
      onRemoteStream: (stream) => {
        this.events.emit("remoteStream", stream);
        if (stream) this.setStatus("connected");
      },
      onChannelOpen: () => this.events.emit("channelOpen"),
    });
  }

  private dropLink(status: CallStatus): void {
    this.link?.close();
    this.link = null;
    this.remotePeerId = null;
    this.events.emit("remoteStream", null);
    this.setStatus(status);
  }

  private setStatus(status: CallStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.emit("status", status);
  }
}
