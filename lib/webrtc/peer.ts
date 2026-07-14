// lib/webrtc/peer.ts
// One peer connection wrapped in the W3C/MDN "perfect negotiation" pattern —
// glare (simultaneous offers) resolves deterministically via polite/impolite
// roles assigned by join order (Phase 2: the pair's newcomer is polite).
// STUN only for now; TURN credentials arrive in Phase 3 via the join reply.
// The data channel is negotiated (same id both sides) so its creation can't
// glare; it carries the Phase 5/6 protocols later.

export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

export interface PeerLinkOptions {
  polite: boolean;
  localStream: MediaStream;
  sendSignal: (payload: string) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?: () => void;
}

export class PeerLink {
  readonly channel: RTCDataChannel;
  private readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(private readonly opts: PeerLinkOptions) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    this.channel = pc.createDataChannel("cos", { negotiated: true, id: 0 });
    this.channel.onopen = () => opts.onChannelOpen?.();

    for (const track of opts.localStream.getTracks()) {
      pc.addTrack(track, opts.localStream);
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        opts.sendSignal(JSON.stringify({ description: pc.localDescription }));
      } catch {
        // a failed negotiation is recovered by session teardown/rebuild
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onicecandidate = (ev) => {
      opts.sendSignal(JSON.stringify({ candidate: ev.candidate }));
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) opts.onRemoteStream(stream);
    };

    pc.onconnectionstatechange = () => opts.onConnectionState?.(pc.connectionState);
  }

  /** Feed a relayed payload (SDP or ICE) into the state machine. */
  async handleSignal(payload: string): Promise<void> {
    let msg: SignalPayload;
    try {
      msg = JSON.parse(payload) as SignalPayload;
    } catch {
      return; // a peer sending garbage is not our crash
    }
    const pc = this.pc;
    if (msg.description) {
      const offerCollision =
        msg.description.type === "offer" &&
        (this.makingOffer || pc.signalingState !== "stable");
      this.ignoreOffer = !this.opts.polite && offerCollision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(msg.description); // implicit rollback (polite side)
      if (msg.description.type === "offer") {
        await pc.setLocalDescription();
        this.opts.sendSignal(JSON.stringify({ description: pc.localDescription }));
      }
    } else if (msg.candidate !== undefined) {
      try {
        await pc.addIceCandidate(msg.candidate ?? undefined);
      } catch (err) {
        if (!this.ignoreOffer) throw err; // candidates for an ignored offer are expected noise
      }
    }
  }

  /** Device switch: swap sender tracks in place — no renegotiation storm. */
  async replaceStream(stream: MediaStream): Promise<void> {
    for (const sender of this.pc.getSenders()) {
      const kind = sender.track?.kind;
      if (!kind) continue;
      await sender.replaceTrack(stream.getTracks().find((t) => t.kind === kind) ?? null);
    }
  }

  close(): void {
    this.pc.close();
  }
}
