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
import { buildScreenShareMsg, buildScreenStopMsg, parseScreenMsg } from "./screenShare";
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
   *  a fresh cos channel and therefore a fresh rising edge (spec).
   *  `failReason` (review fix round 2, Important 4 completion): JoinProof's
   *  own `phase` collapses "bad-mac" and "timeout" into the same terminal
   *  "failed" state, so checking `phase === "failed"` in
   *  checkCountersignFailed would count a timed-out peer toward "every link
   *  failed" too — one later genuine bad-mac elsewhere would then convert a
   *  pile of accumulated timeouts into the refusal card, exactly the
   *  accusation a timeout never made (Important 4's own stated intent).
   *  Tracked per peer, set only inside onFailed, read only by
   *  checkCountersignFailed. */
  private readonly proofs = new Map<string, { proof: JoinProof; failReason: "bad-mac" | "timeout" | null }>();
  /**
   * Review fix round 2 (BLOCKING): latched true the first time ANY peer's
   * proof reaches "proven", for the lifetime of this session — never
   * cleared, including across a 4C rebuild or a later peerLeft. Required
   * (alongside `joinedPopulatedRoom`) in checkCountersignFailed.
   *
   * Why: dropping the `polite` filter (Critical 2's own fix) reopened the
   * false-refusal hole through PEER CHURN instead of a socket blip.
   * `joinedPopulatedRoom` only proves "the room LOOKED populated when I
   * joined" — it says nothing about whether anyone in it ever actually
   * accepted me. Scenario: honest joiner B enters a populated room
   * (joinedPopulatedRoom latches true) and proves peer A. A hangs up —
   * peerLeft deletes A's proof entirely. A wrong-secret peer C now joins:
   * `proofs` is back down to just {C: failed}, `every(...)` is vacuously
   * true, and B — who is completely innocent, having already proven
   * someone — gets the terminal card, now irreversible thanks to the
   * Important-3 `signaling.stop()` fix. `everProvenAnyone` closes this: once
   * we've proven ANYONE, ever, we are definitively not the wrong-secret
   * party, and no amount of later churn can manufacture "every link failed"
   * against us again.
   */
  private everProvenAnyone = false;
  /**
   * Review fix (Critical 2, ratified as D24): latched exactly once, on the
   * FIRST "entered" event this session ever receives, to whatever
   * `info.peers.length > 0` was at that moment — and never recomputed after,
   * no matter how many later "entered" events arrive (every signaling
   * reconnect re-emits one with the room's CURRENT peer list, per
   * signaling.ts). `polite` was the original discriminator for
   * checkCountersignFailed, but it is a per-CONSTRUCTION artifact, not a
   * stable room relationship: a reconnect calls closeAll() (wiping every
   * mesh entry) and then addExistingPeers(..., false) for whoever the
   * server currently lists — which makes us polite toward a peer we were
   * originally impolite toward (an incumbent host, rejoining after a socket
   * blip, who has a wrong-secret squatter still sitting in the room) purely
   * because of when we happened to observe them. This latch is decided once,
   * from the FIRST entered event only, so it can never flip under a
   * reconnect: a host whose very first entry was an empty room stays
   * permanently ineligible for "countersign-failed", exactly like it always
   * was pre-reconnect (see checkCountersignFailed).
   */
  private joinedPopulatedRoom = false;
  private hasEnteredOnce = false;
  /** The outgoing screen share, while one is on the table. Held here (not in
   *  the hook) because links are born at unpredictable times — a newcomer's
   *  stagger, a 4C rebuild, a reconnect's full re-bring-up — and every one
   *  of them must inherit the active share at construction (buildLink) and
   *  hear its announce the moment it proves (onProven). Deliberately
   *  survives dropAll: a signaling blip must not silently end the share. */
  private activeScreen: { track: MediaStreamTrack; stream: MediaStream } | null = null;

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
        onMessage: (peerId, text) => {
          // scr/* is session vocabulary, not app traffic: it mutates mesh
          // roster state (which stream is the peer's screen) and is consumed
          // here — same stance as prf/* being consumed at the link. Proof
          // gating already happened upstream (buildLink's onMessage), so an
          // unproven peer can never file a screen.
          const scr = parseScreenMsg(text);
          if (scr) {
            this.mesh.setRemoteScreen(peerId, scr.t === "scr/share" ? scr.streamId : null);
            return;
          }
          this.events.emit("message", peerId, text);
        },
        // Forwarded to the session's own event surface, PROOF-GATED like
        // every other per-peer app signal (message/xferMessage/xferDrain).
        // Ordering vs. the aggregate `channelClosed` event is deliberately
        // unspecified — it's aggregate-first on a live close but
        // per-channel-first on a mesh-synthesized one (remove/closeAll/
        // rebuild) — so nothing here or downstream may assume an
        // interleaving between the two.
        //
        // Final-review Minor 2: this was the last ungated member of the trust
        // gate. The gate lives HERE, at the app-facing emit, and not at
        // buildLink's link-level callback (where its three siblings sit),
        // because mesh IS a genuine consumer of the ungated link signal: the
        // same callback maintains entry.channelOpen/entry.xferOpen, which
        // drive the openChannels() aggregate and the synthesized closes on
        // remove/closeAll/rebuild. Gating it at the link would leave mesh's
        // own bookkeeping permanently wrong for any peer whose channels
        // opened before its proof settled (SCTP routinely does — see
        // mesh.ts's openChannels() doc). What the APP must not see is an
        // unproven peer's lifecycle, and that is exactly what this drops —
        // buildLink replays whatever is still open the moment the peer
        // proves, so nothing durable is lost.
        //
        // Mesh-synthesized closes (remove/closeAll/rebuildLink) all run while
        // the peer's proof object is still the current, still-proven one —
        // rebuildLink synthesizes before scheduleConstruction ever reaches
        // buildLink, and both dropAll() and leave() call mesh.closeAll()
        // before disposeAllProofs() — so a proven peer's teardown still
        // reaches the engines' handleChannelClosed (useEpisodeExchange's only
        // stall recovery).
        onChannelState: (peerId, channel, state, detail) => {
          if (this.proofs.get(peerId)?.proof.phase !== "proven") return;
          this.events.emit("channelState", peerId, channel, state, detail);
        },
        onXferMessage: (peerId, data) => this.events.emit("xferMessage", peerId, data),
        onXferDrain: (peerId) => this.events.emit("xferDrain", peerId),
      },
    );
    const ev = this.signaling.events;

    ev.on("entered", (info) => {
      if (!this.hasEnteredOnce) {
        this.hasEnteredOnce = true;
        this.joinedPopulatedRoom = info.peers.length > 0; // see the field's doc — decided ONCE
      }
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
        onXferMessage: () => {},
        onXferDrain: () => {},
        onE2eeFailure: (detail) => console.error(`[e2ee] ${detail} (peer ${peerId})`),
      });
    }

    // A prior proof for this SAME peerId (a rebuild superseding an earlier,
    // possibly-proven link) must not linger — it owns an armed setTimeout.
    this.proofs.get(peerId)?.proof.dispose();
    // Fresh link ⇒ fresh rising edge: re-arm the MESSAGE/SEND gate now,
    // unconditionally (covers the rebuild-of-a-previously-proven-peer case —
    // mesh's own initiallyProven only guards the very first construction).
    // Review fix (Important 5): this does NOT drop roster visibility for a
    // peer that was proven before — mesh.setProven(false) only resets the
    // strict, per-rising-edge trust gate; `everProven` (roster visibility)
    // is a separate, sticky flag mesh.ts keeps until revokeVisibility()
    // explicitly drops it below, on an actual (re-)proof failure. Without
    // this split, every 4C rebuild of an already-trusted peer would unmount
    // its tile and reset the SIGNAL LOST badge hold for the whole reconnect
    // window, defeating `recovering`'s entire purpose.
    this.mesh.setProven(peerId, false);

    let link!: PeerLink;
    // Keyed by stream id, not a single slot: with screen share a peer can
    // surface TWO streams (face + screen) before its proof settles, and a
    // one-slot stash would silently drop whichever arrived first.
    const stashedStreams = new Map<string, MediaStream>();
    const proofEvents: ProofEvents = {
      onSend: (text) => {
        link.send(text);
      },
      onProven: () => {
        this.mesh.setProven(peerId, true);
        this.everProvenAnyone = true; // see the field's doc — one-way, never cleared
        for (const stream of stashedStreams.values()) ev.onRemoteStream(stream);
        stashedStreams.clear();
        // A share already on the table is news this peer missed — announce it
        // now that sendTo passes the proven gate. Covers newcomers AND a 4C
        // rebuild's re-proof (the fresh link re-learns the screen id).
        if (this.activeScreen) {
          this.mesh.sendTo(peerId, buildScreenShareMsg(this.activeScreen.stream.id));
        }
        // Replay whatever is CURRENTLY open, read from MESH — the same flags
        // openChannels()/remove()/rebuildLink() act on — rather than from a
        // session-local record of the last event seen. A parallel truth
        // diverges: mesh forwards "error" without flipping the open flag
        // (peer.ts fires onerror on a channel that is still open), so
        // `xfer: open → error` while gated reads "error" in any last-event map
        // and its replay would be skipped, leaving the app permanently unaware
        // that xfer is open — canSend wedged false for the life of the link
        // (useEpisodeExchange) while mesh.sendXferTo would happily succeed.
        // That is the very wedge this replay exists to prevent.
        //
        // A channel that genuinely CLOSED while gated is absent here, and
        // correctly so: the app was never told it opened, so announcing its
        // close would be news about an event it never saw. Strictly after
        // setProven above, so these pass the gate they were held at, and
        // synchronous with it — nothing can close in between.
        for (const channel of this.mesh.openChannelsOf(peerId)) {
          this.events.emit("channelState", peerId, channel, "open", undefined);
        }
      },
      // Review fix (Important 4): JoinProof distinguishes "bad-mac" (the
      // countersign was actually wrong) from "timeout" (nobody answered in
      // 5s — jank, a stalled main thread, or a channel that opened before
      // the far side's JS was ready; NOT evidence about the secret). Only a
      // genuine bad-mac closes the link and can count toward
      // checkCountersignFailed / drop a previously-proven peer's row
      // (revokeVisibility). A timeout just leaves the peer unproven and the
      // link alone — 4C's own connectionState-driven recovery (or a future
      // rebuild) gets a fair shot instead of the session being told, and
      // closing the door on, an accusation the timeout never actually made.
      //
      // Final-review BLOCKING fix, second half: a "timeout" reaching here now
      // means BOTH windows expired (JoinProof re-arms itself once with a
      // fresh nonce first — see its module doc), so this is genuinely the end
      // of the line for this link. It is still not an accusation and still
      // gets no card — but it must not be silent either, which is exactly
      // what it was: the peer stays permanently gated (no messages, no xfer
      // frames, no stream, no roster row) on a link that stays open and
      // connected, so nothing else in the stack ever reports it. Routed
      // through the same console path as onE2eeFailure below rather than the
      // roster/badge: a roster row for an unproven peer is precisely what the
      // gating exists to prevent, and a badge would read as an accusation the
      // timeout hasn't made. This also closes the ledgered "wrong-secret
      // joiner whose peers merely time out never gets the card" case — same
      // root, which is why the ledger said not to fix them separately.
      onFailed: (reason) => {
        this.mesh.setProven(peerId, false);
        const entry = this.proofs.get(peerId);
        if (entry) entry.failReason = reason; // recorded regardless — only "bad-mac" is ever read as a refusal signal
        if (reason === "bad-mac") {
          this.mesh.revokeVisibility(peerId);
          link.close();
          this.checkCountersignFailed();
        } else {
          console.error(
            `[cos] join proof timed out twice (challenge + one retry) for peer ${peerId} — it stays gated: no messages, no transfers, no stream, no roster row, until this link rebuilds`,
          );
        }
      },
    };
    const proof = new JoinProof({
      proofKey: this.crypto.keys.proofKey,
      selfPeerId: this.selfPeerId!, // set before any addExistingPeers/addNewcomer call — see the "entered" handler
      remotePeerId: peerId,
      events: proofEvents,
    });
    this.proofs.set(peerId, { proof, failReason: null });

    // Review fix (Minor 8): if PeerLink construction itself throws, mesh's
    // own construct() evicts the entry (onThrow "evict") or marks it failed
    // ("keep-failed" on a rebuild) — either way THIS peerId's proof, already
    // registered above, would otherwise linger in `this.proofs` forever
    // (nothing else ever disposes/deletes it, short of a "peerLeft"), stuck
    // "pending" — which silently and permanently disables
    // checkCountersignFailed's `every(...)` for the rest of the session.
    try {
      link = new PeerLink({
        polite,
        localStream: this.localStream,
        iceServers: this.iceServers,
        forceRelay: this.forceRelay,
        sendSignal: (payload) => this.signaling.sendRelay(peerId, payload),
        e2ee: { mediaKey: this.crypto.keys.mediaKey, api: this.crypto.api },
        onRemoteStream: (stream) => {
          if (proof.phase === "proven") ev.onRemoteStream(stream);
          else if (stream) stashedStreams.set(stream.id, stream);
          else stashedStreams.clear(); // "went away" clears the lot, like the old null stash
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
        // Deliberately forwarded ungated to MESH (see the mesh callback's own
        // comment above, where the app-facing gate lives): mesh needs every
        // transition to keep entry.channelOpen/xferOpen honest — which is
        // also the single source onProven's replay reads back, so there is no
        // second copy of this state anywhere to drift.
        onChannelState: ev.onChannelState,
        // Review fix (Critical 1): D16 names cos-xfer explicitly alongside
        // cos — "every cos/cos-xfer app message" is gated on proof. Before
        // this, the xfer channel (negotiated, opens independently of "cos")
        // let an unproven peer's xfr/* traffic straight through to
        // useEpisodeExchange's onXferMessage handler, which unconditionally
        // builds a receiver and commits parts off the wire peerId — none of
        // that is safe to run before the peer is trusted, envelope
        // encryption (Task 6) notwithstanding (that protects payload bytes,
        // not receiver construction / panel state / routing).
        onXferMessage: (data) => {
          if (proof.phase === "proven") ev.onXferMessage(data);
        },
        onXferDrain: () => {
          if (proof.phase === "proven") ev.onXferDrain();
        },
        onE2eeFailure: (detail) => console.error(`[e2ee] ${detail} (peer ${peerId})`),
      });
    } catch (err) {
      this.proofs.get(peerId)?.proof.dispose();
      this.proofs.delete(peerId);
      throw err; // mesh.construct()'s own catch handles eviction/keep-failed
    }
    // A link born mid-share inherits the screen track immediately — its
    // addTrack lands in the same negotiation pass as the camera/mic tracks
    // the constructor just added. Fire-and-forget like replaceStream's
    // harmless-race stance: a link torn down this tick just refuses.
    if (this.activeScreen) {
      void link.startScreenShare(this.activeScreen.track, this.activeScreen.stream).catch(() => {});
    }
    return link;
  }

  /** Puts a screen capture on the table: announces its stream id to every
   *  proven peer (so the far side files the incoming stream under the screen
   *  tile, not a face tile) and hands the track to every live link through
   *  the same E2EE funnel as the camera. Links built later inherit it — see
   *  buildLink and onProven. The capture's lifecycle (getDisplayMedia,
   *  track.stop) belongs to the caller, mirroring localStream/useLocalMedia. */
  async startScreenShare(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    this.activeScreen = { track, stream };
    // Announce BEFORE media: the cos message is a data-channel hop, the track
    // needs a whole renegotiation — the id all but always arrives first, so
    // the far side files the stream straight into the screen slot. (Either
    // order is still correct — mesh reconciles both — this just avoids the
    // one-frame face-slot flash.)
    this.mesh.sendAll(buildScreenShareMsg(stream.id));
    await this.mesh.screenShareAll(track, stream);
  }

  /** Clears the table: stop announce to every proven peer, screen senders
   *  parked (track null — no teardown, no renegotiation). */
  async stopScreenShare(): Promise<void> {
    if (!this.activeScreen) return;
    this.activeScreen = null;
    this.mesh.sendAll(buildScreenStopMsg());
    await this.mesh.stopScreenShareAll();
  }

  /**
   * D18/D24: the REFUSED side (wrong secret) surfaces "countersign-failed";
   * the REFUSING side (right secret) never does. Both sides get a symmetric
   * bad-mac failure from JoinProof itself (it can't tell which of the two
   * differing secrets is "wrong"), so the asymmetry has to come from
   * something else purely local.
   *
   * Review fix (Critical 2): the original discriminator was live `polite`
   * (joined vs. joined-by), which is unstable across a signaling reconnect
   * — see `joinedPopulatedRoom`'s doc for the exact attacker-triggerable
   * scenario that broke. `joinedPopulatedRoom` replaces it: latched once,
   * from the FIRST "entered" event only, and never recomputed.
   *
   * Review fix round 2 (BLOCKING): `joinedPopulatedRoom` alone isn't enough
   * — see `everProvenAnyone`'s doc for the peer-churn variant of the same
   * false-refusal hole (B proves A, A leaves, a wrong-secret C joins). Both
   * latches are required: we must have joined a populated room AND never
   * have proven anyone, ever, for "every currently-tracked proof genuinely
   * failed (bad-mac)" to mean "my own invitation was refused" rather than
   * "everyone currently in view happens to be untrustworthy, but I already
   * know I'm not the problem."
   *
   * Review fix round 2 (Important 4 completion): counts only `failReason
   * === "bad-mac"` — a proof still pending, or one that merely timed out,
   * must not contribute to "every link failed" (see `proofs`'s doc).
   *
   * A host whose first entry was an empty room can never reach this
   * (joinedPopulatedRoom false), no matter how the peer list churns
   * afterward. A wrong-secret joiner's first entered event finds the room
   * already populated AND it never proves anyone (both peer secrets differ
   * from its own), so this fires as soon as the last of its peers
   * genuinely fails. A legitimate joiner who has proven even one peer, ever,
   * is permanently safe (everProvenAnyone) — including across that peer
   * later leaving and a stranger arriving in its place.
   */
  private checkCountersignFailed(): void {
    if (!this.joinedPopulatedRoom || this.everProvenAnyone) return;
    const proofs = [...this.proofs.values()];
    if (proofs.length > 0 && proofs.every((p) => p.failReason === "bad-mac")) {
      // Review fix (Important 3): countersign-failed is self-inflicted —
      // unlike every other terminal CallStatus (room-full, room-not-found,
      // etc.), which SignalingClient itself already stops/closes on before
      // ever emitting "refused" — nothing tells the signaling socket to
      // stop here. Left alone, this client keeps its server seat and live
      // socket, so a LATER peerJoined would build a fresh link/proof and,
      // if that one succeeds, onRoster's "≥1 stream ⇒ connected" would
      // silently dissolve this terminal card back into a live call (the
      // exact resurrection-squatting shape 5D exists to close).
      this.signaling.stop();
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
