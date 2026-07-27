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

interface Entry {
  link: MeshLink;
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

  /** We just entered the room: polite toward every peer already present. */
  addExistingPeers(peerIds: string[]): void {
    for (const id of peerIds) this.add(id, true);
    this.emitRoster();
  }

  /** A newcomer arrived after us: we are the incumbent (impolite). */
  addNewcomer(peerId: string): void {
    if (this.entries.has(peerId)) return; // duplicate announce — ignore
    this.add(peerId, false);
    this.emitRoster();
  }

  remove(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    this.entries.delete(peerId);
    entry.link.close();
    if (entry.channelOpen && this.openChannels() === 0) this.cb.onChannelClosed();
    this.emitRoster();
  }

  relay(from: string, payload: string): void {
    // handleSignal can reject on straggler ICE after an ignored offer —
    // expected negotiation noise, never fatal (Phase 2 carry).
    this.entries.get(from)?.link.handleSignal(payload).catch(() => {});
  }

  /** Device switch: swap tracks on every live link — no renegotiation. */
  async replaceStreamAll(stream: MediaStream): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.link.replaceStream(stream)));
  }

  closeAll(): void {
    const hadOpen = this.openChannels() > 0;
    const links = [...this.entries.values()];
    this.entries.clear();
    for (const e of links) e.link.close();
    if (hadOpen) this.cb.onChannelClosed();
    this.emitRoster();
  }

  private add(peerId: string, polite: boolean): void {
    if (this.entries.has(peerId)) return;
    const entry: Entry = {
      link: undefined as unknown as MeshLink, // assigned below, before any async event can fire
      stream: null,
      connectionState: "new",
      channelOpen: false,
    };
    this.entries.set(peerId, entry);
    entry.link = this.createLink(peerId, polite, {
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
