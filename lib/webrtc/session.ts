// lib/webrtc/session.ts
// The React-free call orchestrator: owns the signaling client and (Phase 4B)
// a Mesh of PeerLinks, runs the status machine, and emits UI-facing events.
// React renders what this reports; it never drives negotiation.

import { readCreateToken } from "../createToken";
import { SIGNALING_URL } from "../config";
import { Emitter } from "./emitter";
import { Mesh, type RemotePeer } from "./mesh";
import { PeerLink } from "./peer";
import type { IceServer } from "./protocol";
import { SignalingClient } from "./signaling";

export type { RemotePeer } from "./mesh";
// Phase 5B: React-free consumers (and the hook) import the xfer vocabulary
// from session.ts rather than reaching into mesh.ts directly.
export type { ChannelName, ChannelLifecycle } from "./mesh";
import type { ChannelName, ChannelLifecycle } from "./mesh";

export type CallStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "room-not-found"
  | "room-full"
  | "create-refused"
  | "signal-lost"
  | "recovery-failed";

export type CallEventMap = {
  status: [CallStatus];
  roster: [RemotePeer[]];
  channelOpen: [];
  channelClosed: [];
  message: [string, string];
  // Phase 5B (Task 3): per-peer, per-channel lifecycle and the xfer
  // channel's data/backpressure events — straight mirrors of Mesh's
  // onChannelState/onXferMessage/onXferDrain, peerId-prefixed.
  channelState: [string, ChannelName, ChannelLifecycle, string | undefined];
  xferMessage: [string, string | ArrayBuffer];
  xferDrain: [string];
};

export class CallSession {
  readonly events = new Emitter<CallEventMap>();
  private readonly signaling: SignalingClient;
  private readonly mesh: Mesh;
  private localStream: MediaStream;
  private currentStatus: CallStatus = "connecting";
  private iceServers: IceServer[] | undefined;
  private readonly forceRelay: boolean;

  constructor(
    roomId: string,
    localStream: MediaStream,
    url: string = SIGNALING_URL,
    opts: { forceRelay?: boolean } = {},
  ) {
    this.forceRelay = opts.forceRelay ?? false;
    this.localStream = localStream;
    this.signaling = new SignalingClient(url, roomId, readCreateToken);
    this.mesh = new Mesh(
      (peerId, polite, ev) =>
        new PeerLink({
          polite,
          localStream: this.localStream,
          iceServers: this.iceServers,
          forceRelay: this.forceRelay,
          sendSignal: (payload) => this.signaling.sendRelay(peerId, payload),
          onRemoteStream: ev.onRemoteStream,
          onConnectionState: ev.onConnectionState,
          onChannelOpen: ev.onChannelOpen,
          onMessage: ev.onMessage,
          onChannelState: ev.onChannelState,
          onXferMessage: ev.onXferMessage,
          onXferDrain: ev.onXferDrain,
        }),
      {
        onRoster: (roster) => {
          this.events.emit("roster", roster);
          // ≥1 flowing remote stream = the call is up (aggregate status).
          if (roster.some((p) => p.stream)) this.setStatus("connected");
        },
        onChannelOpen: () => this.events.emit("channelOpen"),
        onChannelClosed: () => this.events.emit("channelClosed"),
        onMessage: (peerId, text) => this.events.emit("message", peerId, text),
        // Straight forward to the session's own event surface. Ordering vs.
        // the aggregate `channelClosed` event is deliberately unspecified —
        // it's aggregate-first on a live close but per-channel-first on a
        // mesh-synthesized one (remove/closeAll/rebuild) — so nothing here
        // or downstream may assume an interleaving between the two.
        onChannelState: (peerId, channel, state, detail) =>
          this.events.emit("channelState", peerId, channel, state, detail),
        onXferMessage: (peerId, data) => this.events.emit("xferMessage", peerId, data),
        onXferDrain: (peerId) => this.events.emit("xferDrain", peerId),
      },
    );
    const ev = this.signaling.events;

    ev.on("entered", (info) => {
      this.iceServers = info.ice; // freshest creds — reconnects re-mint via the join reply
      if (info.peers.length === 0) {
        this.setStatus("waiting");
      } else {
        // We are the newcomer → polite toward every incumbent.
        this.mesh.addExistingPeers(info.peers.map((p) => p.peerId));
      }
    });
    ev.on("peerJoined", (peerId) => this.mesh.addNewcomer(peerId));
    ev.on("peerLeft", (peerId) => {
      this.mesh.remove(peerId);
      if (this.mesh.size === 0) this.setStatus("waiting");
    });
    ev.on("relay", (from, payload) => this.mesh.relay(from, payload));
    // Socket lost: keep local media, tear all links down, rebuild fresh after
    // rejoin (no ICE restart until Phase 4C).
    ev.on("reconnecting", () => this.dropAll("reconnecting"));
    ev.on("refused", (reason, afterEntry) => {
      if (reason === "bad-message") {
        this.dropAll("signal-lost");
        return;
      }
      // Post-entry room-full/room-not-found refusals only go terminal after
      // the ~90s recovery window is exhausted — that patience deserves its
      // own copy, not the cold "channel was struck" card (spec §4C UX).
      // create-refused is excluded: a revoked token isn't a patience story,
      // and the clearance-specific copy is the actionable one.
      const recoverable = reason === "room-full" || reason === "room-not-found";
      this.dropAll(afterEntry && recoverable ? "recovery-failed" : reason);
    });
  }

  get status(): CallStatus {
    return this.currentStatus;
  }

  start(): void {
    this.signaling.start();
  }

  /** Stops signaling and every peer link. Local media belongs to useLocalMedia. */
  leave(): void {
    this.signaling.stop();
    this.mesh.closeAll();
  }

  /** Device switch: swap tracks on every live link without renegotiating. */
  async setLocalStream(stream: MediaStream): Promise<void> {
    this.localStream = stream;
    await this.mesh.replaceStreamAll(stream);
  }

  /** App-message send to one peer. False if unknown, linkless, or channel-closed. */
  sendTo(peerId: string, text: string): boolean {
    return this.mesh.sendTo(peerId, text);
  }

  /** App-message broadcast: linkless/closed peers are skipped, not queued. */
  sendAll(text: string): void {
    this.mesh.sendAll(text);
  }

  /** Xfer-channel send to one peer. False if unknown, linkless, or channel-closed. */
  sendXferTo(peerId: string, data: string | ArrayBuffer): boolean {
    return this.mesh.sendXferTo(peerId, data);
  }

  /** -1 when the peer is unknown or its link isn't built yet. */
  xferBufferedAmount(peerId: string): number {
    return this.mesh.xferBufferedAmount(peerId);
  }

  private dropAll(status: CallStatus): void {
    this.mesh.closeAll();
    this.setStatus(status);
  }

  private setStatus(status: CallStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.emit("status", status);
  }
}
