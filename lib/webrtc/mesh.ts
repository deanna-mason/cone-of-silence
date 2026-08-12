// lib/webrtc/mesh.ts
// Per-peer link bookkeeping for the 2–4 person mesh (Phase 4B). React-free
// AND WebRTC-free: PeerLink construction is injected (LinkFactory) so this
// logic unit-tests with fakes. Politeness generalizes per pair — the newcomer
// is polite toward every peer already present; join order arrives as
// joined.peers (we are the newcomer) vs peer-joined (they are).

// Re-exported so React-free consumers of the Mesh (and its tests) need not
// import peer.ts directly for these shared vocabulary types (Phase 5B).
export type { ChannelName, ChannelLifecycle } from "./peer";
import type { ChannelName, ChannelLifecycle } from "./peer";

export interface RemotePeer {
  peerId: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  /** The stream this peer announced (scr/share) as its shared screen — a
   *  SECOND video stream alongside `stream`, filed apart so the UI can give
   *  it a screen tile instead of a face tile. Optional so predating
   *  RemotePeer literals (tests, fixtures) stay valid; the mesh itself
   *  always emits it. */
  screenStream?: MediaStream | null;
}

/** The slice of PeerLink the mesh drives — tests substitute fakes. */
export interface MeshLink {
  handleSignal(payload: string): Promise<void>;
  replaceStream(stream: MediaStream): Promise<void>;
  restartIce(): void;
  close(): void;
  send(text: string): boolean;
  sendXfer(data: string | ArrayBuffer): boolean;
  xferBufferedAmount(): number;
  /** Screen-share fan-out (both optional so predating fakes stay valid —
   *  same additivity stance as RemotePeer.screenStream). */
  startScreenShare?(track: MediaStreamTrack, stream: MediaStream): Promise<void>;
  stopScreenShare?(): Promise<void>;
}

/** Per-link callbacks the factory must wire into the real PeerLink. */
export interface LinkEvents {
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
  onMessage: (text: string) => void;
  onChannelState: (channel: ChannelName, state: ChannelLifecycle, detail?: string) => void;
  onXferMessage: (data: string | ArrayBuffer) => void;
  onXferDrain: () => void;
}

export type LinkFactory = (peerId: string, polite: boolean, events: LinkEvents) => MeshLink;

export interface MeshCallbacks {
  onRoster: (roster: RemotePeer[]) => void;
  onChannelOpen: () => void; // open-channel count went 0 → 1
  onChannelClosed: () => void; // open-channel count returned to 0
  onMessage: (peerId: string, text: string) => void;
  onChannelState: (peerId: string, channel: ChannelName, state: ChannelLifecycle, detail?: string) => void;
  onXferMessage: (peerId: string, data: string | ArrayBuffer) => void;
  onXferDrain: (peerId: string) => void;
}

/**
 * Delay before each PeerLink is constructed when we join a room that already
 * holds peers. Peer i is built at (i + 1) * STAGGER_MS — so no link is ever
 * constructed inside the signaling handler's own tick, and no two are
 * constructed in the same tick.
 *
 * Why: building an `RTCPeerConnection` synchronously inside the signaling
 * WebSocket's message handler wedges Chromium's ICE agent. `iceGatheringState`
 * sticks at "gathering", not one local `icecandidate` event ever fires, so no
 * candidate pair can form and the link never leaves "new" — permanently, not
 * slowly. Reproduced across three binaries (chrome-headless-shell, Chromium
 * 1223, system Google Chrome 150). In the e2e mesh scenario the wedged
 * connection was, in 5 of 5 failing runs, *always* the one built in the handler
 * tick; every link built on a later tick connected. This is not test-only — a
 * real participant joining a populated room hits exactly the same path.
 *
 * Signals that arrive for a peer whose link is not built yet are queued and
 * replayed on construction — dropping an initial offer deadlocks the pair,
 * since nothing re-triggers negotiation.
 */
export const STAGGER_MS = 250;

/** `disconnected` often self-heals in 1–3s — only restart ICE when it
 *  persists past this grace (matches the badge's appearance delay). */
export const DISCONNECTED_RESTART_MS = 3_000;
/** If restartIce hasn't recovered the link by now, rebuild it outright. */
export const RESTART_RECOVERY_MS = 10_000;
/** Rebuild attempts per link before we stop and let the badge tell the truth. */
export const MAX_LINK_REBUILDS = 2;
/** Bound on a peer's queued-but-not-yet-applied signals (drop newest past
 *  this — see relay()) — a peer that never gets a link back (rebuild
 *  capped, or the rebuild's own construction throws) must not grow this
 *  without bound. */
export const MAX_PENDING_SIGNALS = 64;

interface Entry {
  /** null until this link's staggered construction turn comes up. */
  link: MeshLink | null;
  polite: boolean;
  /** Signals relayed before the link existed, replayed in arrival order. */
  pending: string[];
  /**
   * Serializes signal application for this peer: every payload — drained or
   * live — is appended here, so each reaches handleSignal only after the
   * previous one has settled (see feed()).
   */
  chain: Promise<void>;
  /** Pending construction, cancelled on remove()/closeAll(). */
  timer: ReturnType<typeof setTimeout> | null;
  stream: MediaStream | null;
  /** Every remote MediaStream this link has surfaced, by stream id — the
   *  reconciliation surface for scr/share: the announce and the `track`
   *  event can land in either order, so BOTH sides of the match are kept
   *  and deriveStreams() re-files on every change. Cleared on rebuild (a
   *  fresh pc surfaces fresh streams). */
  streams: Map<string, MediaStream>;
  /** The stream id this peer's scr/share announced, null when not sharing.
   *  Survives a rebuild: the sharer re-announces on the fresh link's proof,
   *  and the same MediaStream object keeps its id across re-adds. */
  screenStreamId: string | null;
  /** Every id EVER announced as a screen. A stream doesn't change species:
   *  once a screen, never the face — including after a stop, when the
   *  retained stream would otherwise be "the most recent" and win the face
   *  slot. Retention (not deletion) is load-bearing for RE-shares: they
   *  reuse the negotiated sender (replaceTrack, no renegotiation), so no
   *  fresh `track` event ever re-delivers the stream — re-filing what we
   *  kept is the only way the tile comes back (8/11 live-test regression). */
  screenIds: Set<string>;
  /** Derived: streams[screenStreamId] when both halves have arrived. */
  screenStream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  channelOpen: boolean;
  /** Xfer (cos-xfer) channel open state — tracked separately from cos:
   *  channelOpen keeps meaning "cos open" for the aggregate, unchanged. */
  xferOpen: boolean;
  /** Pending failed/disconnected escalation, cancelled on recovery/removal. */
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  /** What recoveryTimer is currently waiting on — null when none is armed.
   *  "grace": the disconnected self-heal window (cancellable by "failed").
   *  "fallback": the restart-recovery rebuild deadline (never preempted). */
  recoveryPhase: "grace" | "fallback" | null;
  rebuilds: number;
  /** Set once the pending queue has dropped a signal, so the cap only warns once. */
  pendingCapWarned: boolean;
  /** True while a recovery attempt is in flight — a same-pc restartIce
   *  (armed from onLinkState's "failed" branch or the disconnected
   *  grace-expiry escalation) or a full rebuildLink teardown/reconstruct —
   *  until the link reports "connected" or is superseded by a further
   *  attempt. Either path can cycle the pc through "new"/"connecting" as a
   *  side effect (restartIce renegotiates through the same
   *  onnegotiationneeded/connectionstatechange plumbing a fresh connection
   *  does), and while this is true, construct()'s onConnectionState
   *  callback suppresses those writes — see construct(), onLinkState(), and
   *  rebuildLink(). */
  recovering: boolean;
  /** Phase 5D (Task 5), additive: gates app-message send/receive (sendTo/
   *  sendAll/sendXferTo) and the dcOpen aggregate. Defaults to true (see
   *  add()'s `initiallyProven` param) so every pre-5D caller — which never
   *  touches proof state at all — sees the exact same behavior as before.
   *  CallSession (the only production caller that cares) adds every peer
   *  with initiallyProven=false and flips it via setProven() around its own
   *  JoinProof lifecycle, resetting it to false on every fresh rising edge
   *  (including a 4C rebuild) — strict, no memory across links. Roster
   *  VISIBILITY is a separate, stickier concern — see `everProven`. */
  proven: boolean;
  /** Review fix (Important 5), additive: latches true the first time
   *  `proven` is ever set true, and — unlike `proven` — is NOT reset by a
   *  fresh rising edge (a 4C rebuild re-arming `proven` to false for the
   *  re-proof window). Gates roster() visibility instead of `proven`: a
   *  peer that has been proven at least once keeps its tile/badge through a
   *  rebuild's re-proof window (connectionState/recovering already carry
   *  the honest "still down" story — see mesh's recovering doc), rather
   *  than unmounting and remounting every reconnect. Only revokeVisibility()
   *  drops it back to false, when a fresh proof of a previously-proven peer
   *  genuinely fails. Defaults to `initiallyProven`, same additivity as
   *  `proven` — pre-5D callers never see a difference between the two. */
  everProven: boolean;
}

export class Mesh {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly createLink: LinkFactory,
    private readonly cb: MeshCallbacks,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Phase 5D (Task 5), additive: a never-proven entry is invisible here —
   *  no roster row, no participant count — until setProven(peerId, true).
   *  Filters on `everProven` (review fix, Important 5), not the stricter
   *  `proven` — a peer proven at least once keeps its row through a 4C
   *  rebuild's re-proof window; see `everProven`'s doc. Pre-5D callers never
   *  touch either flag, so both default true and this filter is a no-op
   *  (every entry passes). */
  roster(): RemotePeer[] {
    return [...this.entries]
      .filter(([, e]) => e.everProven)
      .map(([peerId, e]) => ({
        peerId,
        stream: e.stream,
        // Present only while a screen is actually on the table — absent
        // otherwise, so every predating exact-shape roster assertion (and
        // consumer) sees the identical object it always did (additivity).
        ...(e.screenStream ? { screenStream: e.screenStream } : {}),
        connectionState: e.connectionState,
      }));
  }

  /**
   * We just entered the room: polite toward every peer already present.
   * Every entry exists immediately — roster, size and relay routing all know
   * the full peer set from this tick on — but the links come up one per
   * STAGGER_MS, the first one included, so none is constructed inside the
   * signaling handler's tick and no two share a tick (see STAGGER_MS). The
   * schedule falls out of add()'s own stagger cursor now (see add()) — no
   * index math needed here.
   *
   * `initiallyProven` (Phase 5D, Task 5, additive): defaults to true so
   * every pre-5D caller is unaffected. CallSession passes false — a room
   * key'd for join-proof gating starts every peer invisible until its own
   * JoinProof proves them.
   */
  addExistingPeers(peerIds: string[], initiallyProven = true): void {
    peerIds.forEach((id) => this.add(id, true, initiallyProven));
    this.emitRoster();
  }

  /** A newcomer arrived after us: we are the incumbent (impolite). Deferred
   *  off the peer-joined handler tick like every other construction — the
   *  4B wedge diagnosis was "constructed inside the signaling handler tick",
   *  and with restart+rebuild now underneath, there is no reason to keep
   *  the one remaining in-tick construction path. `initiallyProven`: see
   *  addExistingPeers' doc. */
  addNewcomer(peerId: string, initiallyProven = true): void {
    if (this.entries.has(peerId)) return; // duplicate announce — ignore
    this.add(peerId, false, initiallyProven);
    this.emitRoster();
  }

  /**
   * Phase 5D (Task 5), additive: flips one peer's message-gate state.
   * `proven: true` also latches `everProven` (see its doc) — one-way, never
   * cleared here (only revokeVisibility() clears it). No-op on an unknown
   * peer (already torn down) or a redundant call (same value).
   *
   * Review fix (Minor 7): re-checks the dcOpen aggregate around the flip.
   * `openChannels()` now counts only proven entries (see its doc) — a cos
   * channel that physically opened before its peer proved never counted
   * toward the aggregate in the first place, so nothing re-fires
   * onChannelOpen for it once that channel-open event has already come and
   * gone; this is the ONLY place that later transition gets noticed and
   * (re-)dispatched, in either direction (a fresh rising edge's
   * setProven(false) can equally drop the aggregate to 0 if this was the
   * only proven-open peer).
   */
  setProven(peerId: string, proven: boolean): void {
    const entry = this.entries.get(peerId);
    if (!entry || entry.proven === proven) return;
    const wasOpenAgg = this.openChannels() > 0;
    entry.proven = proven;
    if (proven) entry.everProven = true;
    const isOpenAgg = this.openChannels() > 0;
    if (!wasOpenAgg && isOpenAgg) this.cb.onChannelOpen();
    else if (wasOpenAgg && !isOpenAgg) this.cb.onChannelClosed();
    this.emitRoster();
  }

  /** Review fix (Important 5), additive: drops a peer's roster visibility
   *  even though it was proven before — called when a FRESH proof (e.g.
   *  post-rebuild) of a previously-proven peer genuinely fails (bad-mac).
   *  No-op if the peer was never visible to begin with (everProven already
   *  false) or is unknown. */
  revokeVisibility(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry || !entry.everProven) return;
    entry.everProven = false;
    this.emitRoster();
  }

  remove(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    this.entries.delete(peerId);
    this.cancelPending(entry);
    entry.link?.close();
    // Synthesized closes: the mesh killed this link, so the mesh reports the
    // deaths — a straggling real onclose from the discarded link is eaten by
    // the identity guard in construct()'s event wiring.
    // `&& entry.proven` (review fix round 2, Minor 7 completion): this entry
    // is already gone from `this.entries` by the time openChannels() runs
    // below, so an unproven entry's own channelOpen flag can't have
    // contributed to that count in the first place — without the guard, a
    // removed-but-never-proven peer whose channel happened to be open could
    // fire a spurious onChannelClosed purely because the (correctly
    // proven-filtered) remaining aggregate reads 0, even though it was
    // already 0 before this removal and no onChannelOpen ever fired for it.
    const hadChannelOpen = entry.channelOpen && entry.proven;
    if (entry.channelOpen) {
      entry.channelOpen = false;
      this.cb.onChannelState(peerId, "cos", "closed");
    }
    if (entry.xferOpen) {
      entry.xferOpen = false;
      this.cb.onChannelState(peerId, "xfer", "closed");
    }
    if (hadChannelOpen && this.openChannels() === 0) this.cb.onChannelClosed();
    this.emitRoster();
  }

  relay(from: string, payload: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;
    // The link may not be built yet (staggered bring-up, or a rebuild in
    // flight). Queue rather than drop: losing an initial offer deadlocks the
    // pair — nothing re-triggers negotiation. Capped so a peer whose link
    // never comes back (rebuild exhausted, or its construction throws)
    // doesn't grow this without bound — and capped by dropping the NEWEST
    // arrival, not the oldest: the head of the queue is the offer everything
    // behind it depends on, so evicting it would deadlock the pair with a
    // full-looking queue of orphaned candidates. Shedding trailing
    // candidates instead is survivable ICE loss.
    if (!entry.link) {
      if (entry.pending.length >= MAX_PENDING_SIGNALS) {
        if (!entry.pendingCapWarned) {
          entry.pendingCapWarned = true;
          console.warn(`[mesh] pending signal queue capped at ${MAX_PENDING_SIGNALS} for ${from}; dropping newest`);
        }
        return;
      }
      entry.pending.push(payload);
      return;
    }
    this.feed(entry, entry.link, payload);
  }

  /** Device switch: swap tracks on every live link — no renegotiation. */
  async replaceStreamAll(stream: MediaStream): Promise<void> {
    // Links still awaiting construction are skipped — they read the session's
    // current stream from the (late-bound) factory when they are built.
    const links = [...this.entries.values()].map((e) => e.link).filter((l) => l !== null);
    await Promise.all(links.map((l) => l.replaceStream(stream)));
  }

  /** Screen share: hand the screen track to every BUILT link. Links still
   *  awaiting construction are skipped, same as replaceStreamAll — the
   *  session gives a late-built link the active screen at construction. */
  async screenShareAll(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const links = [...this.entries.values()].map((e) => e.link).filter((l) => l !== null);
    await Promise.all(links.map((l) => l.startScreenShare?.(track, stream)));
  }

  async stopScreenShareAll(): Promise<void> {
    const links = [...this.entries.values()].map((e) => e.link).filter((l) => l !== null);
    await Promise.all(links.map((l) => l.stopScreenShare?.()));
  }

  /** Files (or un-files, streamId null) a peer's announced screen stream id
   *  — the inbound half of scr/share, called by the session's message
   *  interception. Order-proof against the media itself: deriveStreams
   *  re-files whatever streams have already arrived, and a later `track`
   *  event re-derives against this id. No-op on an unknown peer (already
   *  torn down — its announce is a straggler). */
  setRemoteScreen(peerId: string, streamId: string | null): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    // The stream stays FILED on a stop (see screenIds' doc — a re-share
    // re-points at it with no fresh track event); screenIds keeps it out of
    // the face slot forever.
    if (streamId !== null) entry.screenIds.add(streamId);
    entry.screenStreamId = streamId;
    this.deriveStreams(entry);
    this.emitRoster();
  }

  /** Send to one peer. False if the peer is unknown, unproven, linkless, or
   *  channel-closed (Phase 5D, Task 5: an unproven peer is treated exactly
   *  like an unknown one — see roster()'s doc on the default-true additivity). */
  sendTo(peerId: string, text: string): boolean {
    const entry = this.entries.get(peerId);
    if (!entry || !entry.proven) return false;
    return entry.link?.send(text) ?? false;
  }

  /** Best-effort broadcast: linkless/closed/unproven entries are skipped,
   *  not queued (Phase 5D, Task 5: unproven skip is additive — see sendTo). */
  sendAll(text: string): void {
    for (const entry of this.entries.values()) {
      if (entry.proven) entry.link?.send(text);
    }
  }

  /** Send over the xfer channel to one peer. False if unknown, unproven,
   *  linkless, or channel-closed (Phase 5D review fix: D16 names cos-xfer
   *  explicitly — "every cos/cos-xfer app message" is proof-gated, same as
   *  sendTo/sendAll above). */
  sendXferTo(peerId: string, data: string | ArrayBuffer): boolean {
    const entry = this.entries.get(peerId);
    if (!entry || !entry.proven) return false;
    return entry.link?.sendXfer(data) ?? false;
  }

  /** Which of this peer's channels the mesh currently holds OPEN, in a fixed
   *  cos-then-xfer order. Exists for CallSession's proof-gated channelState
   *  replay (see session.ts's onProven): the app-facing lifecycle events of
   *  an unproven peer are dropped, so whatever is still open at proving time
   *  has to be re-announced — and it must be re-announced from THIS state,
   *  the same flags openChannels()/remove()/rebuildLink() act on, rather than
   *  from a session-local record of the last event seen. Those two diverge:
   *  "error" is forwarded WITHOUT flipping the open flag (see construct()'s
   *  onChannelState), so a channel that errored while still open reads
   *  "error" in any last-event map but is, correctly, still open here.
   *  Empty for an unknown peer. */
  openChannelsOf(peerId: string): ChannelName[] {
    const entry = this.entries.get(peerId);
    if (!entry) return [];
    const open: ChannelName[] = [];
    if (entry.channelOpen) open.push("cos");
    if (entry.xferOpen) open.push("xfer");
    return open;
  }

  /** -1 when the peer is unknown or its link isn't built yet. */
  xferBufferedAmount(peerId: string): number {
    const link = this.entries.get(peerId)?.link;
    return link ? link.xferBufferedAmount() : -1;
  }

  closeAll(): void {
    const hadOpen = this.openChannels() > 0;
    const entries = [...this.entries];
    this.entries.clear();
    for (const [peerId, e] of entries) {
      this.cancelPending(e);
      e.link?.close();
      // Synthesized closes — see remove()'s comment for the rationale.
      if (e.channelOpen) {
        e.channelOpen = false;
        this.cb.onChannelState(peerId, "cos", "closed");
      }
      if (e.xferOpen) {
        e.xferOpen = false;
        this.cb.onChannelState(peerId, "xfer", "closed");
      }
    }
    if (hadOpen) this.cb.onChannelClosed();
    this.emitRoster();
  }

  private add(peerId: string, polite: boolean, initiallyProven: boolean): void {
    if (this.entries.has(peerId)) return;
    const entry: Entry = {
      link: null,
      polite,
      pending: [],
      chain: Promise.resolve(),
      timer: null,
      stream: null,
      streams: new Map(),
      screenStreamId: null,
      screenIds: new Set(),
      screenStream: null,
      connectionState: "new",
      channelOpen: false,
      xferOpen: false,
      recoveryTimer: null,
      recoveryPhase: null,
      rebuilds: 0,
      pendingCapWarned: false,
      recovering: false,
      proven: initiallyProven,
      everProven: initiallyProven,
    };
    this.entries.set(peerId, entry);
    this.scheduleConstruction(peerId, entry, "evict");
  }

  /**
   * Unified stagger cursor, shared by initial bring-up (add()) and a
   * rebuild's reconstruction (rebuildLink()): this entry lands one
   * STAGGER_MS slot after however many OTHER entries are already waiting on
   * their own construction timer — reproducing addExistingPeers' old
   * (i + 1) index math for a whole batch, while also spacing out two
   * newcomers (or a newcomer and an in-flight rebuild) that land in the
   * same tick. There is deliberately no path left that constructs inside
   * the caller's own tick (see STAGGER_MS) — the last one (addNewcomer's
   * synchronous incumbent build) closed in the recovery work above.
   *
   * This is count-based rather than a true monotonic deadline (each call
   * computes "how many others are pending right now" rather than tracking
   * an absolute next-free-slot cursor). The two agree whenever adds land in
   * the same tick (the common case: a signaling batch, or two peers
   * announcing back to back) — for adds arriving in different ticks that
   * are still within a stagger of each other, count-based errs toward
   * *more* spacing, not less, so it never collapses two constructions into
   * the same tick; it just occasionally waits a slot longer than the bare
   * minimum. That trade avoids threading a Date-free "now" source through
   * the mesh for a benefit that's cosmetic, not correctness-bearing.
   */
  private scheduleConstruction(peerId: string, entry: Entry, onThrow: "evict" | "keep-failed"): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer); // defensive: never stack two construction timers
    }
    let pendingSlots = 0;
    for (const e of this.entries.values()) if (e !== entry && e.timer !== null) pendingSlots += 1;
    const delay = STAGGER_MS * (pendingSlots + 1);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(peerId) !== entry) return; // removed while waiting
      this.construct(peerId, entry, onThrow);
    }, delay);
  }

  /**
   * @param onThrow How to handle the factory throwing. "evict" (initial
   *   construction): drop the peer — a half-initialized entry that can never
   *   connect is worse than no entry. "keep-failed" (rebuild path): the peer
   *   was live a moment ago; evicting it would vanish a real participant
   *   over a transient factory error, so keep the entry mapped with no link
   *   and connectionState "failed" — the badge tells the truth instead.
   */
  private construct(peerId: string, entry: Entry, onThrow: "evict" | "keep-failed" = "evict"): void {
    let link: MeshLink;
    try {
      link = this.createLink(peerId, entry.polite, {
        onRemoteStream: (stream) => {
          // entry.link !== link: this link was superseded by a rebuild —
          // discarded links can still fire trailing events asynchronously.
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          if (stream) entry.streams.set(stream.id, stream);
          else entry.streams.clear(); // "the stream went away" — same meaning null always had here
          this.deriveStreams(entry);
          this.emitRoster();
        },
        onConnectionState: (state) => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          if (entry.recovering) {
            if (state === "new" || state === "connecting") {
              // Suppress: the roster must keep reporting "failed" through
              // the whole recovery attempt (restartIce or a full rebuild —
              // see onLinkState() and rebuildLink()) — a "new"/"connecting"
              // climb here isn't honest news yet, whether it's a fresh pc
              // from a rebuild or the SAME pc cycling through renegotiation
              // mid-restartIce, and writing it would flip the badge off
              // while the link is genuinely still down.
              return;
            }
            if (state === "connected") entry.recovering = false;
            // "failed"/"disconnected" fall through unmodified: a failing
            // recovery attempt is honest news, and drives the next cycle
            // normally (recovering stays true — still suppressing "new"/
            // "connecting" until this link either connects or is replaced).
          }
          entry.connectionState = state;
          this.onLinkState(peerId, entry, state);
          this.emitRoster();
        },
        onChannelOpen: () => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          const wasOpen = this.openChannels() > 0;
          entry.channelOpen = true;
          // Review fix (Minor 7): openChannels() now counts only PROVEN
          // entries — an unproven peer's channel physically opening must
          // not move the dcOpen aggregate (see openChannels()'s doc). Without
          // the `entry.proven` guard, `!wasOpen` alone would fire this for
          // an unproven peer whose flip doesn't actually change the filtered
          // count at all.
          if (!wasOpen && entry.proven) this.cb.onChannelOpen();
        },
        onMessage: (text) => {
          // Same identity guard as the other link events: a superseded
          // (rebuilt-away) link can still fire a trailing message.
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          this.cb.onMessage(peerId, text);
        },
        onChannelState: (channel, state, detail) => {
          // Same identity guard as every other link event — a straggling
          // real close/error from a link the mesh already discarded (rebuild,
          // remove, closeAll) must not touch the entry now owned by a
          // replacement link, or double-fire the aggregate below.
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          if (state === "open") {
            if (channel === "cos") {
              const wasOpen = this.openChannels() > 0;
              entry.channelOpen = true;
              // Review fix (Minor 7): see the plain onChannelOpen handler's
              // comment above — same `entry.proven` guard, same reason.
              if (!wasOpen && entry.proven) this.cb.onChannelOpen();
            } else {
              entry.xferOpen = true;
            }
          } else if (state === "closed") {
            if (channel === "cos") {
              // `&& entry.proven`: without it, an UNPROVEN entry's channel
              // closing could read `openChannels() === 1` purely because
              // some OTHER, actually-proven peer is open — firing a spurious
              // onChannelClosed even though that other peer's channel never
              // closed (this entry never contributed to the count in the
              // first place).
              const wasOnlyOpen = entry.channelOpen && entry.proven && this.openChannels() === 1;
              entry.channelOpen = false;
              if (wasOnlyOpen) this.cb.onChannelClosed();
            } else {
              entry.xferOpen = false;
            }
          }
          // "error" forwards without flipping the open flag — an error is
          // often followed by a close, and the close flips it then.
          this.cb.onChannelState(peerId, channel, state, detail);
        },
        onXferMessage: (data) => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          this.cb.onXferMessage(peerId, data);
        },
        onXferDrain: () => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          this.cb.onXferDrain(peerId);
        },
      });
    } catch (err) {
      console.error(`[mesh] link construction failed for ${peerId}`, err);
      if (onThrow === "evict") {
        // Construction usually runs on a timer tick, where a throwing
        // factory would surface as an uncaught error and strand a
        // half-initialized entry (roster row that can never connect, queue
        // that never drains). Drop the peer instead; the roster shows the truth.
        this.entries.delete(peerId);
        this.cancelPending(entry);
        this.emitRoster();
        return;
      }
      entry.link = null;
      entry.connectionState = "failed";
      entry.chain = Promise.resolve();
      this.emitRoster();
      return;
    }
    entry.link = link;
    const queued = entry.pending;
    entry.pending = [];
    for (const payload of queued) this.feed(entry, link, payload);
  }

  /**
   * Per-link recovery: failed → restart now, rebuild if that doesn't take;
   * disconnected → restart only once it outlives the self-heal grace.
   *
   * Once a recovery timer is armed it runs to completion regardless of
   * intermediate connectionState churn — only "connected" cancels it. This
   * replaces an earlier design that cleared the timer on every transition:
   * restartIce reliably moves the state through "connecting", which used to
   * disarm the fallback before it could ever fire — the fallback was dead
   * code against real browsers, and repeated failures could restart ICE
   * indefinitely with no bound.
   *
   * One exception: "failed" preempts an armed "grace" timer (the
   * disconnected self-heal window) but never an armed "fallback" timer (the
   * post-restart rebuild deadline). A disconnected link that then reports
   * failed is definitively bad — waiting out a grace period designed to
   * catch a *transient* disconnect no longer serves any purpose, so restart
   * ICE immediately and start the fallback clock from now instead of from
   * whenever the grace timer happens to expire.
   *
   * Both restartIce call sites below also set entry.recovering — restartIce
   * renegotiates the SAME pc, cycling it through "new"/"connecting" exactly
   * like a fresh connection would, and construct()'s onConnectionState
   * callback suppresses those writes while recovering is set so the roster
   * (and the badge reading it) keeps reporting the truth instead of
   * flickering "connecting" mid-restart. See construct() and rebuildLink().
   */
  private onLinkState(peerId: string, entry: Entry, state: RTCPeerConnectionState): void {
    if (state === "connected") {
      if (entry.recoveryTimer !== null) {
        clearTimeout(entry.recoveryTimer);
        entry.recoveryTimer = null;
      }
      entry.recoveryPhase = null;
      entry.rebuilds = 0;
      return;
    }
    if (state === "failed") {
      if (entry.recoveryTimer !== null) {
        if (entry.recoveryPhase === "fallback") return; // already pending — one restart per armed cycle
        // phase === "grace": failed preempts the disconnected self-heal
        // window — we already know the link is bad, no reason to wait out a
        // grace period meant for a state we've since moved past. Fall
        // through to arm the fallback fresh, from now.
        clearTimeout(entry.recoveryTimer);
        entry.recoveryTimer = null;
      }
      entry.recovering = true; // restartIce can cycle the pc through "new"/"connecting" too
      entry.link?.restartIce();
      entry.recoveryPhase = "fallback";
      entry.recoveryTimer = setTimeout(() => {
        entry.recoveryTimer = null;
        entry.recoveryPhase = null;
        if (this.entries.get(peerId) !== entry) return;
        this.rebuildLink(peerId, entry);
      }, RESTART_RECOVERY_MS);
      return;
    }
    if (state === "disconnected") {
      if (entry.recoveryTimer !== null) return; // grace or fallback already pending
      entry.recoveryPhase = "grace";
      entry.recoveryTimer = setTimeout(() => {
        entry.recoveryTimer = null;
        entry.recoveryPhase = null;
        if (this.entries.get(peerId) !== entry) return;
        // Load-bearing under the "leave armed timers alone" rule above: an
        // intermediate state can no longer cancel this timer on its own, so
        // a genuine self-heal is only detectable here — by connectionState
        // having reached "connected" by the time the grace period elapses.
        if (entry.connectionState === "connected") return;
        entry.recovering = true; // same reasoning as the failed-branch restartIce above
        entry.link?.restartIce();
        entry.recoveryPhase = "fallback";
        entry.recoveryTimer = setTimeout(() => {
          entry.recoveryTimer = null;
          entry.recoveryPhase = null;
          if (this.entries.get(peerId) !== entry) return;
          this.rebuildLink(peerId, entry);
        }, RESTART_RECOVERY_MS);
      }, DISCONNECTED_RESTART_MS);
      return;
    }
    // "new", "connecting", "closed": leave any armed timer alone.
  }

  /** Last resort for a link restartIce couldn't save: tear down just this
   *  pair and bring it up fresh through the normal deferred path — same
   *  politeness, same entry, queue intact for anything that arrives
   *  meanwhile. Bounded: after MAX_LINK_REBUILDS the state stays failed and
   *  the tile badge carries the truth. Both sides usually observe failure
   *  and rebuild together; an asymmetric rebuild renegotiates against the
   *  remote's existing pc via perfect negotiation.
   */
  private rebuildLink(peerId: string, entry: Entry): void {
    if (entry.rebuilds >= MAX_LINK_REBUILDS) return;
    entry.rebuilds += 1;
    entry.link?.close();
    entry.link = null;
    entry.stream = null;
    // The dead pc's streams with it — the replacement surfaces fresh ones.
    // screenStreamId/screenIds stay: the sharer re-announces on the fresh
    // link's proof, and until then a stale id merely matches nothing.
    entry.streams.clear();
    entry.screenStream = null;
    entry.chain = Promise.resolve();
    // connectionState is deliberately left alone here (typically "failed")
    // through the whole rebuild window — Task 4's badge reads this field
    // directly, and a peer with no link should read as failed, not silently
    // revert to "new". That promise only holds because of `recovering`
    // below (the same flag a same-pc restartIce sets in onLinkState): the
    // replacement pc's own "new"/"connecting" climb fires through the SAME
    // onConnectionState callback once construct() runs, and without this
    // flag those transitions would overwrite connectionState right back to
    // "connecting" — which the badge treats as not-yet-a-problem and hides
    // on, even though the link is genuinely still down. construct()'s
    // onConnectionState callback checks this flag and suppresses
    // "new"/"connecting" writes while it's set; "connected" clears it, and
    // "failed"/"disconnected" pass through as honest news.
    entry.recovering = true;
    // `&& entry.proven`: see the identical guard in construct()'s
    // onChannelState "closed" branch (Minor 7 review fix) — same reasoning.
    const wasOnlyOpen = entry.channelOpen && entry.proven && this.openChannels() === 1;
    if (entry.channelOpen) {
      entry.channelOpen = false; // old channel died with the old pc
      this.cb.onChannelState(peerId, "cos", "closed"); // synthesized — see remove()
    }
    if (entry.xferOpen) {
      entry.xferOpen = false;
      this.cb.onChannelState(peerId, "xfer", "closed");
    }
    if (wasOnlyOpen) this.cb.onChannelClosed();
    this.emitRoster();
    // Routed through the same stagger cursor as initial bring-up (never
    // construct in the current tick — 4B rule — and space out against any
    // other pending construction rather than always landing flat
    // STAGGER_MS later regardless of what else is queued). "keep-failed": a
    // rebuild's own construction throwing must not evict a peer that was
    // live a moment ago (see construct()'s onThrow doc).
    this.scheduleConstruction(peerId, entry, "keep-failed");
  }

  /**
   * Apply one payload, strictly after the peer's previous payload settled.
   * handleSignal is async and is NOT internally serialized: overlapping calls
   * interleave at their awaits, so an ICE candidate can reach addIceCandidate
   * while the offer ahead of it is still suspended in setRemoteDescription —
   * remoteDescription is null, the call rejects InvalidStateError, and the
   * candidate is silently lost. Chaining keeps arrival order and gives each
   * payload the state the sender assumed.
   *
   * A rejection is swallowed per payload (straggler ICE after an ignored
   * offer is expected negotiation noise, never fatal — Phase 2 carry) and
   * never breaks the chain for the payloads behind it.
   */
  private feed(entry: Entry, link: MeshLink, payload: string): void {
    entry.chain = entry.chain.then(() => link.handleSignal(payload)).catch(() => {});
  }

  /** Re-files entry.stream/entry.screenStream from the streams this link has
   *  surfaced and the announced screen id. The face slot keeps its old
   *  "most recent stream wins" semantics — excluding anything ever announced
   *  as a screen (screenIds), live share or not. */
  private deriveStreams(entry: Entry): void {
    let primary: MediaStream | null = null;
    for (const s of entry.streams.values()) {
      if (!entry.screenIds.has(s.id)) primary = s;
    }
    entry.stream = primary;
    entry.screenStream = entry.screenStreamId !== null ? (entry.streams.get(entry.screenStreamId) ?? null) : null;
  }

  private cancelPending(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.recoveryTimer !== null) {
      clearTimeout(entry.recoveryTimer);
      entry.recoveryTimer = null;
    }
    entry.pending = [];
  }

  /** Review fix (Minor 7): counts only PROVEN entries — an unproven peer's
   *  cos channel opening (SCTP can establish ~5s before its proof settles)
   *  must not move the dcOpen aggregate (podcast-panel gating etc.) any more
   *  than it moves the roster. Pre-5D callers never set proven=false, so
   *  this is a no-op filter for them (identical to the old plain sum). */
  private openChannels(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.channelOpen && e.proven) n += 1;
    return n;
  }

  private emitRoster(): void {
    this.cb.onRoster(this.roster());
  }
}
