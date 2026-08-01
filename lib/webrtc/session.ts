// lib/webrtc/session.ts
// The React-free call orchestrator: owns the signaling client and (Phase 4B)
// a Mesh of PeerLinks, runs the status machine, and emits UI-facing events.
// React renders what this reports; it never drives negotiation.

import { readCreateToken } from "../createToken";
import { SIGNALING_URL } from "../config";
import type { RoomCryptoKeys } from "../crypto/derive";
import { Emitter } from "./emitter";
import type { E2eeApi } from "./e2eeSupport";
import { JoinProof, type ProofEvents } from "./joinProof";
import { Mesh, type LinkEvents, type RemotePeer } from "./mesh";
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
  | "recovery-failed"
  // Phase 5D (Task 5): "equipment-outdated" is set by the HOOK, before any
  // CallSession exists at all (derivation failure or no e2ee transform API on
  // this browser — D15) — it lives in this union purely so page.tsx's
  // CALL_FAILURE_COPY (keyed by CallStatus) can cover it. CallSession itself
  // sets "countersign-failed" — see the join-proof gating below.
  | "countersign-failed"
  | "equipment-outdated";

/** Phase 5D (Task 5): every room key, derived once by the hook from the
 *  never-sent URL-fragment secret (lib/crypto/derive.ts). D15 — every
 *  production call supplies this; CallSession requires it (no plaintext
 *  fallback). */
export interface SessionCrypto {
  keys: RoomCryptoKeys;
  api: E2eeApi;
}

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
  private readonly crypto: SessionCrypto;
  /** Our own peerId, learned from the signaling "entered" reply. Every
   *  addExistingPeers/addNewcomer call (and therefore every link factory
   *  call) happens strictly after this is set — see the "entered" handler
   *  below. Phase 5D (Task 5): JoinProof needs it (mutual, bound to
   *  selfPeerId/remotePeerId — see joinProof.ts). */
  private selfPeerId: string | null = null;
  /** Phase 5D (Task 5): one live JoinProof per remote peer, replaced (old one
   *  disposed first) on every fresh link — including a 4C rebuild, which is
   *  a fresh cos channel and therefore a fresh rising edge (spec). `polite`
   *  is carried alongside so checkCountersignFailed can restrict "every link
   *  failed" to the peers WE joined (see that method's doc — this is what
   *  makes D18's asymmetry work without any crypto-level signal for it). */
  private readonly proofs = new Map<string, { proof: JoinProof; polite: boolean }>();

  constructor(
    roomId: string,
    localStream: MediaStream,
    crypto: SessionCrypto,
    url: string = SIGNALING_URL,
    opts: { forceRelay?: boolean } = {},
  ) {
    this.forceRelay = opts.forceRelay ?? false;
    this.localStream = localStream;
    this.crypto = crypto;
    this.signaling = new SignalingClient(url, roomId, readCreateToken);
    this.mesh = new Mesh(
      (peerId, polite, ev) => this.buildLink(peerId, polite, ev),
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
      this.selfPeerId = info.selfId;
      this.iceServers = info.ice; // freshest creds — reconnects re-mint via the join reply
      if (info.peers.length === 0) {
        this.setStatus("waiting");
      } else {
        // We are the newcomer → polite toward every incumbent. Phase 5D
        // (Task 5): initiallyProven=false — every peer starts invisible
        // until ITS OWN join-proof succeeds (see buildLink/roster()).
        this.mesh.addExistingPeers(info.peers.map((p) => p.peerId), false);
      }
    });
    ev.on("peerJoined", (peerId) => this.mesh.addNewcomer(peerId, false));
    ev.on("peerLeft", (peerId) => {
      this.mesh.remove(peerId);
      this.proofs.get(peerId)?.proof.dispose();
      this.proofs.delete(peerId);
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

  /**
   * Phase 5D (Task 5) join-proof gating, additive on top of 4B/4C's link
   * wiring. One JoinProof per remote peer, created fresh every time THIS
   * function runs — which mesh.ts calls once for the initial link and again,
   * unchanged, for every 4C rebuild (fresh PeerLink, fresh cos channel, so a
   * fresh rising edge per spec: "4C rebuild of a proven peer re-runs the
   * proof on the fresh link"). Until `proof.phase === "proven"`:
   *   - `prf/*` messages are consumed by the proof itself (handleMessage);
   *   - every OTHER inbound app message is dropped, not queued;
   *   - a remote stream is stashed, not surfaced (surfaced once, on proven);
   *   - the peer is invisible to the roster (mesh.setProven gates that).
   * `recovering`'s roster-suppression semantics (mesh.ts) are untouched by
   * any of this — this only ever calls mesh.setProven, never touches
   * connectionState/recovering directly.
   */
  private buildLink(peerId: string, polite: boolean, ev: LinkEvents): PeerLink {
    // Carry-over guard from the Task 3 review: mesh has no concept of a self
    // peerId, so a roster that ever echoed our own id would otherwise crash
    // here (JoinProof's constructor throws on selfPeerId === remotePeerId).
    // Should-never-happen defensively: construct the link but never prove it
    // — permanently invisible/silent rather than a thrown error inside
    // signaling-driven construction.
    if (peerId === this.selfPeerId) {
      console.error(`[cos] mesh peer id (${peerId}) matches our own — refusing to join-proof it; it will never be proven`);
      return new PeerLink({
        polite,
        localStream: this.localStream,
        iceServers: this.iceServers,
        forceRelay: this.forceRelay,
        sendSignal: (payload) => this.signaling.sendRelay(peerId, payload),
        e2ee: { mediaKey: this.crypto.keys.mediaKey, api: this.crypto.api },
        onRemoteStream: () => {},
        onConnectionState: ev.onConnectionState,
        onChannelOpen: ev.onChannelOpen,
        onMessage: () => {},
        onChannelState: ev.onChannelState,
        onXferMessage: ev.onXferMessage,
        onXferDrain: ev.onXferDrain,
        onE2eeFailure: (detail) => console.error(`[e2ee] ${detail} (peer ${peerId})`),
      });
    }

    // A prior proof for this SAME peerId (a rebuild superseding an earlier,
    // possibly-proven link) must not linger — it owns an armed setTimeout.
    this.proofs.get(peerId)?.proof.dispose();
    // Fresh link ⇒ fresh rising edge: re-arm gating now, unconditionally.
    // Covers the rebuild-of-a-previously-proven-peer case (mesh's own
    // initiallyProven only guards the very first construction).
    this.mesh.setProven(peerId, false);

    let link!: PeerLink;
    let stashedStream: MediaStream | null = null;
    const proofEvents: ProofEvents = {
      onSend: (text) => {
        link.send(text);
      },
      onProven: () => {
        this.mesh.setProven(peerId, true);
        if (stashedStream) {
          const stream = stashedStream;
          stashedStream = null;
          ev.onRemoteStream(stream);
        }
      },
      onFailed: () => {
        this.mesh.setProven(peerId, false);
        link.close();
        this.checkCountersignFailed();
      },
    };
    const proof = new JoinProof({
      proofKey: this.crypto.keys.proofKey,
      selfPeerId: this.selfPeerId!, // set before any addExistingPeers/addNewcomer call — see the "entered" handler
      remotePeerId: peerId,
      events: proofEvents,
    });
    this.proofs.set(peerId, { proof, polite });

    link = new PeerLink({
      polite,
      localStream: this.localStream,
      iceServers: this.iceServers,
      forceRelay: this.forceRelay,
      sendSignal: (payload) => this.signaling.sendRelay(peerId, payload),
      e2ee: { mediaKey: this.crypto.keys.mediaKey, api: this.crypto.api },
      onRemoteStream: (stream) => {
        if (proof.phase === "proven") ev.onRemoteStream(stream);
        else stashedStream = stream;
      },
      onConnectionState: ev.onConnectionState,
      onChannelOpen: () => {
        ev.onChannelOpen();
        proof.start();
      },
      onMessage: (text) => {
        if (proof.handleMessage(text)) return; // prf/* — consumed, never forwarded
        if (proof.phase === "proven") ev.onMessage(text);
        // else: dropped, not queued — an unproven peer's messages never reach the app.
      },
      onChannelState: ev.onChannelState,
      onXferMessage: ev.onXferMessage,
      onXferDrain: ev.onXferDrain,
      onE2eeFailure: (detail) => console.error(`[e2ee] ${detail} (peer ${peerId})`),
    });
    return link;
  }

  /**
   * D18: the REFUSED side (wrong secret) surfaces "countersign-failed"; the
   * REFUSING side (right secret) never does. Both sides get a symmetric
   * bad-mac failure from JoinProof itself (it can't tell which of the two
   * differing secrets is "wrong"), so the asymmetry has to come from
   * something else purely local: `polite`. We are polite toward a peer only
   * when WE joined an already-populated room (addExistingPeers) — that is
   * the shape of "presenting an invitation to enter." Being joined BY a
   * newcomer (impolite) is not our own join attempt, so a stranger failing
   * proof against us there says nothing about our own secret.
   *
   * So: only once EVERY polite (joined) relationship we currently hold has
   * failed do we conclude our own invitation was refused. A host with zero
   * polite relationships (it never joined anyone — every peer joined it)
   * never reaches this at all, matching "a right-secret host whose single
   * stranger fails proof just never sees them." A wrong-secret joiner's
   * polite relationships are ALL it has (every peer looked already-present
   * to it), so this fires as soon as the last of them fails.
   */
  private checkCountersignFailed(): void {
    const polite = [...this.proofs.values()].filter((e) => e.polite);
    if (polite.length > 0 && polite.every((e) => e.proof.phase === "failed")) {
      this.dropAll("countersign-failed");
    }
  }

  private disposeAllProofs(): void {
    for (const { proof } of this.proofs.values()) proof.dispose();
    this.proofs.clear();
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
    this.disposeAllProofs();
  }

  /** Device switch: swap tracks on every live link without renegotiating. */
  async setLocalStream(stream: MediaStream): Promise<void> {
    this.localStream = stream;
    await this.mesh.replaceStreamAll(stream);
  }

  /** App-message send to one peer. False if unknown, unproven, linkless, or
   *  channel-closed (Phase 5D — an unproven peer never receives app traffic). */
  sendTo(peerId: string, text: string): boolean {
    return this.mesh.sendTo(peerId, text);
  }

  /** App-message broadcast: linkless/closed/unproven peers are skipped, not queued. */
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
    this.disposeAllProofs();
    this.setStatus(status);
  }

  private setStatus(status: CallStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.emit("status", status);
  }
}
