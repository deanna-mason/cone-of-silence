// lib/webrtc/mesh.ts
// Per-peer link bookkeeping for the 2–4 person mesh (Phase 4B). React-free
// AND WebRTC-free: PeerLink construction is injected (LinkFactory) so this
// logic unit-tests with fakes. Politeness generalizes per pair — the newcomer
// is polite toward every peer already present; join order arrives as
// joined.peers (we are the newcomer) vs peer-joined (they are).

export interface RemotePeer {
  peerId: string;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
}

/** The slice of PeerLink the mesh drives — tests substitute fakes. */
export interface MeshLink {
  handleSignal(payload: string): Promise<void>;
  replaceStream(stream: MediaStream): Promise<void>;
  restartIce(): void;
  close(): void;
}

/** Per-link callbacks the factory must wire into the real PeerLink. */
export interface LinkEvents {
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState: (state: RTCPeerConnectionState) => void;
  onChannelOpen: () => void;
}

export type LinkFactory = (peerId: string, polite: boolean, events: LinkEvents) => MeshLink;

export interface MeshCallbacks {
  onRoster: (roster: RemotePeer[]) => void;
  onChannelOpen: () => void; // open-channel count went 0 → 1
  onChannelClosed: () => void; // open-channel count returned to 0
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
/** Bound on a peer's queued-but-not-yet-applied signals (drop oldest past
 *  this) — a peer that never gets a link back (rebuild capped, or the
 *  rebuild's own construction throws) must not grow this without bound. */
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
  connectionState: RTCPeerConnectionState;
  channelOpen: boolean;
  /** Pending failed/disconnected escalation, cancelled on recovery/removal. */
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  rebuilds: number;
  /** Set once the pending queue has dropped a signal, so the cap only warns once. */
  pendingCapWarned: boolean;
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

  roster(): RemotePeer[] {
    return [...this.entries].map(([peerId, e]) => ({
      peerId,
      stream: e.stream,
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
   */
  addExistingPeers(peerIds: string[]): void {
    peerIds.forEach((id) => this.add(id, true));
    this.emitRoster();
  }

  /** A newcomer arrived after us: we are the incumbent (impolite). Deferred
   *  off the peer-joined handler tick like every other construction — the
   *  4B wedge diagnosis was "constructed inside the signaling handler tick",
   *  and with restart+rebuild now underneath, there is no reason to keep
   *  the one remaining in-tick construction path. */
  addNewcomer(peerId: string): void {
    if (this.entries.has(peerId)) return; // duplicate announce — ignore
    this.add(peerId, false);
    this.emitRoster();
  }

  remove(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    this.entries.delete(peerId);
    this.cancelPending(entry);
    entry.link?.close();
    if (entry.channelOpen && this.openChannels() === 0) this.cb.onChannelClosed();
    this.emitRoster();
  }

  relay(from: string, payload: string): void {
    const entry = this.entries.get(from);
    if (!entry) return;
    // The link may not be built yet (staggered bring-up, or a rebuild in
    // flight). Queue rather than drop: losing an initial offer deadlocks the
    // pair — nothing re-triggers negotiation. Capped so a peer whose link
    // never comes back (rebuild exhausted, or its construction throws)
    // doesn't grow this without bound.
    if (!entry.link) {
      entry.pending.push(payload);
      if (entry.pending.length > MAX_PENDING_SIGNALS) {
        entry.pending.shift(); // drop oldest
        if (!entry.pendingCapWarned) {
          entry.pendingCapWarned = true;
          console.warn(`[mesh] pending signal queue capped at ${MAX_PENDING_SIGNALS} for ${from}; dropping oldest`);
        }
      }
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

  closeAll(): void {
    const hadOpen = this.openChannels() > 0;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const e of entries) {
      this.cancelPending(e);
      e.link?.close();
    }
    if (hadOpen) this.cb.onChannelClosed();
    this.emitRoster();
  }

  /**
   * Unified stagger cursor: this entry lands one STAGGER_MS slot after
   * however many other entries are already waiting on their own
   * construction timer — reproducing addExistingPeers' old (i + 1) index
   * math for a whole batch, while also spacing out two newcomers who
   * announce in the same tick. There is deliberately no path left that
   * constructs inside the caller's own tick (see STAGGER_MS) — the last one
   * (addNewcomer's synchronous incumbent build) closed in the recovery
   * work above.
   */
  private add(peerId: string, polite: boolean): void {
    if (this.entries.has(peerId)) return;
    const entry: Entry = {
      link: null,
      polite,
      pending: [],
      chain: Promise.resolve(),
      timer: null,
      stream: null,
      connectionState: "new",
      channelOpen: false,
      recoveryTimer: null,
      rebuilds: 0,
      pendingCapWarned: false,
    };
    this.entries.set(peerId, entry);
    let pendingSlots = 0;
    for (const e of this.entries.values()) if (e !== entry && e.timer !== null) pendingSlots += 1;
    const delay = STAGGER_MS * (pendingSlots + 1);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(peerId) !== entry) return; // removed while waiting
      this.construct(peerId, entry);
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
          entry.stream = stream;
          this.emitRoster();
        },
        onConnectionState: (state) => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          entry.connectionState = state;
          this.onLinkState(peerId, entry, state);
          this.emitRoster();
        },
        onChannelOpen: () => {
          if (this.entries.get(peerId) !== entry || entry.link !== link) return;
          const wasOpen = this.openChannels() > 0;
          entry.channelOpen = true;
          if (!wasOpen) this.cb.onChannelOpen();
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
   */
  private onLinkState(peerId: string, entry: Entry, state: RTCPeerConnectionState): void {
    if (state === "connected") {
      if (entry.recoveryTimer !== null) {
        clearTimeout(entry.recoveryTimer);
        entry.recoveryTimer = null;
      }
      entry.rebuilds = 0;
      return;
    }
    if (state === "failed") {
      if (entry.recoveryTimer !== null) return; // fallback already pending — one restart per armed cycle
      entry.link?.restartIce();
      entry.recoveryTimer = setTimeout(() => {
        entry.recoveryTimer = null;
        if (this.entries.get(peerId) !== entry) return;
        this.rebuildLink(peerId, entry);
      }, RESTART_RECOVERY_MS);
      return;
    }
    if (state === "disconnected") {
      if (entry.recoveryTimer !== null) return; // grace or fallback already pending
      entry.recoveryTimer = setTimeout(() => {
        entry.recoveryTimer = null;
        if (this.entries.get(peerId) !== entry) return;
        // Load-bearing under the "leave armed timers alone" rule above: an
        // intermediate state can no longer cancel this timer on its own, so
        // a genuine self-heal is only detectable here — by connectionState
        // having reached "connected" by the time the grace period elapses.
        if (entry.connectionState === "connected") return;
        entry.link?.restartIce();
        entry.recoveryTimer = setTimeout(() => {
          entry.recoveryTimer = null;
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
    entry.chain = Promise.resolve();
    // connectionState is deliberately left alone here (typically "failed")
    // through the whole rebuild window — Task 4's badge reads this field
    // directly, and a peer with no link should read as failed, not silently
    // revert to "new".
    const wasOnlyOpen = entry.channelOpen && this.openChannels() === 1;
    entry.channelOpen = false; // old channel died with the old pc
    if (wasOnlyOpen) this.cb.onChannelClosed();
    this.emitRoster();
    if (entry.timer !== null) {
      // Defensive: nothing should already have a construction timer pending
      // on a live entry, but never stack two.
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(peerId) !== entry) return;
      // "keep-failed": a rebuild's own construction throwing must not evict
      // a peer that was live a moment ago (see construct()'s onThrow doc).
      this.construct(peerId, entry, "keep-failed");
    }, STAGGER_MS); // never construct in the current tick (4B rule)
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

  private openChannels(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.channelOpen) n += 1;
    return n;
  }

  private emitRoster(): void {
    this.cb.onRoster(this.roster());
  }
}
