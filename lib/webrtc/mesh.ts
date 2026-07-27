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

interface Entry {
  /** null until this link's staggered construction turn comes up. */
  link: MeshLink | null;
  polite: boolean;
  /** Signals relayed before the link existed, replayed in arrival order. */
  pending: string[];
  /** Pending construction, cancelled on remove()/closeAll(). */
  timer: ReturnType<typeof setTimeout> | null;
  stream: MediaStream | null;
  connectionState: RTCPeerConnectionState;
  channelOpen: boolean;
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
   * signaling handler's tick and no two share a tick (see STAGGER_MS).
   */
  addExistingPeers(peerIds: string[]): void {
    peerIds.forEach((id, i) => this.add(id, true, (i + 1) * STAGGER_MS));
    this.emitRoster();
  }

  /** A newcomer arrived after us: we are the incumbent (impolite). */
  addNewcomer(peerId: string): void {
    if (this.entries.has(peerId)) return; // duplicate announce — ignore
    this.add(peerId, false, 0); // a lone new connection never needs staggering
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
    // The link may not be built yet (staggered bring-up). Queue rather than
    // drop: losing an initial offer deadlocks the pair — nothing re-triggers
    // negotiation.
    if (!entry.link) {
      entry.pending.push(payload);
      return;
    }
    this.feed(entry.link, payload);
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

  private add(peerId: string, polite: boolean, delayMs: number): void {
    if (this.entries.has(peerId)) return;
    const entry: Entry = {
      link: null,
      polite,
      pending: [],
      timer: null,
      stream: null,
      connectionState: "new",
      channelOpen: false,
    };
    this.entries.set(peerId, entry);
    if (delayMs <= 0) {
      this.construct(peerId, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.entries.get(peerId) !== entry) return; // removed while waiting
      this.construct(peerId, entry);
    }, delayMs);
  }

  private construct(peerId: string, entry: Entry): void {
    entry.link = this.createLink(peerId, entry.polite, {
      onRemoteStream: (stream) => {
        if (this.entries.get(peerId) !== entry) return; // stale link — dropped already
        entry.stream = stream;
        this.emitRoster();
      },
      onConnectionState: (state) => {
        if (this.entries.get(peerId) !== entry) return;
        entry.connectionState = state;
        this.emitRoster();
      },
      onChannelOpen: () => {
        if (this.entries.get(peerId) !== entry) return;
        const wasOpen = this.openChannels() > 0;
        entry.channelOpen = true;
        if (!wasOpen) this.cb.onChannelOpen();
      },
    });
    const queued = entry.pending;
    entry.pending = [];
    for (const payload of queued) this.feed(entry.link, payload);
  }

  private feed(link: MeshLink, payload: string): void {
    // handleSignal can reject on straggler ICE after an ignored offer —
    // expected negotiation noise, never fatal (Phase 2 carry).
    link.handleSignal(payload).catch(() => {});
  }

  private cancelPending(entry: Entry): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
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
