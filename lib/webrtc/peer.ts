// lib/webrtc/peer.ts
// One peer connection wrapped in the W3C/MDN "perfect negotiation" pattern —
// glare (simultaneous offers) resolves deterministically via polite/impolite
// roles assigned by join order (Phase 4B: the newcomer is polite toward
// every peer already present; one PeerLink per pair, owned by the Mesh).
// STUN only for now; TURN credentials arrive via the join reply (Phase 4A).
// The data channel is negotiated (same id both sides) so its creation can't
// glare; it carries the Phase 5/6 protocols later.

import { vp9Preferences, type E2eeApi } from "./e2eeSupport";

export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type ChannelName = "cos" | "xfer";
export type ChannelLifecycle = "open" | "closed" | "error";
/** Sender resumes pumping when bufferedAmount drops below this (set as
 *  bufferedAmountLowThreshold on the xfer channel at construction). */
export const XFER_LOW_WATER = 1_048_576; // 1 MiB
/** Sender stops pumping while bufferedAmount is at/above this (Task 7). */
export const XFER_HIGH_WATER = 4_194_304; // 4 MiB

interface SignalPayload {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
}

export interface PeerLinkOptions {
  polite: boolean;
  localStream: MediaStream;
  iceServers?: RTCIceServer[]; // from the join reply (Phase 4A); STUN fallback otherwise
  forceRelay?: boolean; // ?forceTurn=1 debug flag — relay-only ICE
  sendSignal: (payload: string) => void;
  onRemoteStream: (stream: MediaStream | null) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?: () => void;
  onMessage?: (text: string) => void;
  onChannelState?: (channel: ChannelName, state: ChannelLifecycle, detail?: string) => void;
  onXferMessage?: (data: string | ArrayBuffer) => void;
  onXferDrain?: () => void;
  /** Phase 5D hardening: the ONLY signal that e2ee media is silently dead —
   *  a crashed worker, an undeliverable postMessage, a pipe that rejected
   *  under it, or a VP9 pin that got skipped (E2EE on + no VP9 means the
   *  H.264 packetizer can't packetize encrypted frames). Optional so
   *  additivity holds: nothing calls this when opts.e2ee is absent, and no
   *  predating caller needs to supply it. */
  onE2eeFailure?: (detail: string) => void;
  /** Phase 5D (D15): every room key is present in production — the SESSION
   *  always supplies this. Absent ONLY in tests that predate 5D, where its
   *  absence must mean zero behavior change (no worker, no transform, no
   *  codec pin, no encodedInsertableStreams) — that optionality is itself
   *  the additivity proof for every 4B/4C/5A/5B test. */
  e2ee?: { mediaKey: CryptoKey; api: E2eeApi };
}

function errDetail(ev: unknown): string {
  return (ev as RTCErrorEvent).error?.message ?? "channel error";
}

/** The legacy ("encoded-streams") transform API predates standardization and
 * never made it into TypeScript's DOM lib — createEncodedStreams simply
 * isn't a declared member of RTCRtpSender/RTCRtpReceiver there. These narrow
 * intersection types are the cast surface, confined to this file. */
interface LegacyEncodedStreams {
  readable: ReadableStream;
  writable: WritableStream;
}
type SenderWithStreams = RTCRtpSender & { createEncodedStreams(): LegacyEncodedStreams };
type ReceiverWithStreams = RTCRtpReceiver & { createEncodedStreams(): LegacyEncodedStreams };

/** The worker's only outbound message shape (lib/webrtc/e2ee.worker.ts) —
 *  a pipe failure it can't recover from, relayed here to onE2eeFailure. */
interface WorkerErrorMsg {
  op: "error";
  detail: string;
}
function isWorkerErrorMsg(data: unknown): data is WorkerErrorMsg {
  return typeof data === "object" && data !== null && (data as { op?: unknown }).op === "error";
}

export class PeerLink {
  readonly channel: RTCDataChannel;
  readonly xfer: RTCDataChannel;
  private readonly pc: RTCPeerConnection;
  /** One worker per PeerLink (Phase 5D), null when opts.e2ee is absent.
   *  Created here, terminated in close() — a 4C rebuild always constructs a
   *  fresh PeerLink, so this is never reused across rebuilds either. */
  private readonly worker: Worker | null;
  /** Guards against a second `track` event for a receiver already wired
   *  (spec-legal: a transceiver's fired direction can go non-receiving →
   *  receiving again). Without this, a second attach would call
   *  `createEncodedStreams()` twice on the same receiver — which throws —
   *  and since that throw happens inside `ontrack` BEFORE the
   *  `onRemoteStream` call below it, the tile would silently never appear. */
  private readonly attachedReceivers = new WeakSet<RTCRtpReceiver>();
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(private readonly opts: PeerLinkOptions) {
    const e2ee = opts.e2ee;
    const pc = new RTCPeerConnection({
      iceServers: opts.iceServers ?? ICE_SERVERS,
      ...(opts.forceRelay ? { iceTransportPolicy: "relay" as const } : {}),
      // Legacy API only — script-transform needs no pc-level opt-in (spec).
      ...(e2ee?.api === "encoded-streams" ? { encodedInsertableStreams: true } : {}),
    });
    this.pc = pc;
    const worker = e2ee ? new Worker(new URL("./e2ee.worker.ts", import.meta.url)) : null;
    this.worker = worker;

    // Everything below can throw (createEncodedStreams, setCodecPreferences,
    // ...) before the constructor finishes. If it does, `worker` — created
    // above — would otherwise leak with no reference anywhere for close()
    // to terminate later. Catch, terminate, rethrow.
    try {
      if (worker) {
        worker.onerror = (ev) => {
          this.reportE2eeFailure(`e2ee worker error: ${ev.message || "unknown"}`);
        };
        worker.onmessageerror = () => {
          this.reportE2eeFailure("e2ee worker received an unstructured-clonable message it could not deserialize");
        };
        worker.onmessage = (ev) => {
          if (isWorkerErrorMsg(ev.data)) this.reportE2eeFailure(ev.data.detail);
        };
      }

      this.channel = pc.createDataChannel("cos", { negotiated: true, id: 0 });
      this.channel.onopen = () => {
        opts.onChannelOpen?.();
        opts.onChannelState?.("cos", "open");
      };
      this.channel.onclose = () => opts.onChannelState?.("cos", "closed");
      this.channel.onerror = (ev) => opts.onChannelState?.("cos", "error", errDetail(ev));
      this.channel.onmessage = (ev) => {
        if (typeof ev.data === "string") opts.onMessage?.(ev.data);
      };

      // The episode-exchange channel (Phase 5B). Negotiated like cos so creation
      // can't glare, and constructed HERE so a Phase-4C rebuild — which builds a
      // fresh PeerLink — re-creates both channels automatically (spec §5B).
      this.xfer = pc.createDataChannel("cos-xfer", { negotiated: true, id: 1 });
      this.xfer.binaryType = "arraybuffer";
      this.xfer.bufferedAmountLowThreshold = XFER_LOW_WATER;
      this.xfer.onopen = () => opts.onChannelState?.("xfer", "open");
      this.xfer.onclose = () => opts.onChannelState?.("xfer", "closed");
      this.xfer.onerror = (ev) => opts.onChannelState?.("xfer", "error", errDetail(ev));
      this.xfer.onbufferedamountlow = () => opts.onXferDrain?.();
      this.xfer.onmessage = (ev) => {
        if (typeof ev.data === "string" || ev.data instanceof ArrayBuffer) opts.onXferMessage?.(ev.data);
      };

      for (const track of opts.localStream.getTracks()) {
        const sender = pc.addTrack(track, opts.localStream);
        // Additivity (D15): when e2ee is absent, this loop body is IDENTICAL
        // to pre-5D — no getTransceivers() call, no transform, no pin — so a
        // pre-5D fake pc (no getTransceivers/setCodecPreferences) never sees
        // these calls and every predating test stays green unchanged.
        if (e2ee) {
          this.attachSenderTransform(sender);
          const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
          if (transceiver) this.applyVp9Pin(transceiver);
        }
      }

      pc.onnegotiationneeded = async () => {
        try {
          this.makingOffer = true;
          // Re-pin every transceiver ahead of each offer (spec: Codec pin) —
          // catches any transceiver the addTrack-time pin above didn't see.
          if (e2ee) {
            for (const transceiver of pc.getTransceivers()) this.applyVp9Pin(transceiver);
          }
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
        this.attachReceiverTransform(ev.receiver);
        const stream = ev.streams[0];
        if (stream) opts.onRemoteStream(stream);
      };

      pc.onconnectionstatechange = () => opts.onConnectionState?.(pc.connectionState);
    } catch (err) {
      worker?.terminate();
      throw err;
    }
  }

  /** The single funnel for every e2ee robustness signal (Phase 5D hardening):
   *  a dead worker, an unrelayable pipe failure, or a skipped VP9 pin. Logs
   *  via this directory's existing `console.error("[tag] ...")` idiom
   *  (mesh.ts, media.ts) and forwards to the optional app-level callback. */
  private reportE2eeFailure(detail: string): void {
    console.error(`[e2ee] ${detail}`);
    this.opts.onE2eeFailure?.(detail);
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

  /** ICE restart (Phase 4C): flows through the existing perfect-negotiation
   *  offer path — negotiationneeded fires with fresh ICE credentials. */
  restartIce(): void {
    this.pc.restartIce();
  }

  close(): void {
    this.pc.close();
    this.worker?.terminate();
  }

  /** Attaches an encrypt transform to a just-added local sender. No-op when
   *  opts.e2ee is absent (additivity — see PeerLinkOptions.e2ee's doc).
   *  Senders are only ever created here (construction's addTrack loop); a
   *  later replaceStream() call swaps the TRACK on this same sender via
   *  replaceTrack, which never touches — and therefore never needs to
   *  re-attach — `sender.transform` (it lives on the sender, not the
   *  track), so existing transforms survive device switches for free. */
  private attachSenderTransform(sender: RTCRtpSender): void {
    const e2ee = this.opts.e2ee;
    if (!e2ee || !this.worker) return;
    if (e2ee.api === "script-transform") {
      sender.transform = new RTCRtpScriptTransform(this.worker, { key: e2ee.mediaKey, side: "encrypt" });
    } else {
      const { readable, writable } = (sender as SenderWithStreams).createEncodedStreams();
      this.worker.postMessage({ op: "pipe", key: e2ee.mediaKey, side: "encrypt", readable, writable }, [
        readable,
        writable,
      ]);
    }
  }

  /** Attaches a decrypt transform to a remote receiver — called from
   *  `ontrack`, off `ev.receiver`, per pipe-per-track like the sender side.
   *  Guarded by `attachedReceivers`: a second `track` event for a receiver
   *  already wired is spec-legal (a transceiver's fired direction can go
   *  non-receiving → receiving again) but `createEncodedStreams()` throws on
   *  a receiver that already has an active pipe — this makes that
   *  unreachable rather than relying on it never happening in practice. */
  private attachReceiverTransform(receiver: RTCRtpReceiver): void {
    const e2ee = this.opts.e2ee;
    if (!e2ee || !this.worker) return;
    if (this.attachedReceivers.has(receiver)) return;
    this.attachedReceivers.add(receiver);
    if (e2ee.api === "script-transform") {
      receiver.transform = new RTCRtpScriptTransform(this.worker, { key: e2ee.mediaKey, side: "decrypt" });
    } else {
      const { readable, writable } = (receiver as ReceiverWithStreams).createEncodedStreams();
      this.worker.postMessage({ op: "pipe", key: e2ee.mediaKey, side: "decrypt", readable, writable }, [
        readable,
        writable,
      ]);
    }
  }

  /** Codec pin (spec): E2EE on → video pinned to VP9, because the H.264
   *  packetizer needs to parse frame contents that E2EE has made opaque.
   *  Video-only; skipped entirely when the platform has no VP9 codec
   *  (vp9Preferences returns null) rather than pinning to an empty list. */
  private applyVp9Pin(transceiver: RTCRtpTransceiver): void {
    if (!this.opts.e2ee) return;
    const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind;
    if (kind !== "video") return;
    // Defensive, mirroring e2eeSupport's own guard: e2ee is only ever
    // supplied in production once detectE2eeApi() confirmed a real
    // transform API exists (which itself requires RTCRtpSender to exist),
    // but a bare global lookup would throw ReferenceError in any host
    // (test or otherwise) that hasn't defined it at all — skip the pin
    // rather than crash the constructor.
    const rtpSender = (globalThis as { RTCRtpSender?: { getCapabilities(kind: string): RTCRtpCapabilities | null } })
      .RTCRtpSender;
    if (!rtpSender) {
      // E2EE on, video track, but nothing to pin against — not "no
      // preference," a broken call: with E2EE on, an unpinned H.264
      // packetizer cannot packetize the now-opaque frames.
      this.reportE2eeFailure("e2ee: VP9 pin skipped for a video track — RTCRtpSender.getCapabilities unavailable");
      return;
    }
    const prefs = vp9Preferences(rtpSender.getCapabilities("video"));
    if (!prefs) {
      this.reportE2eeFailure("e2ee: VP9 pin skipped for a video track — platform has no VP9 codec");
      return;
    }
    transceiver.setCodecPreferences(prefs);
  }

  /** App-message send over the cos channel. False (not queued) unless open.
   *  channel.send can throw even after the readyState check passes (the
   *  transport can close the channel between the check and the send) — that
   *  refusal must surface as `false`, never a throw: joinProof's
   *  issueChallenge calls this BEFORE arming its retry timeout, so an
   *  escaping throw on the retry path strands the proof `pending` forever. */
  send(text: string): boolean {
    if (this.channel.readyState !== "open") return false;
    try {
      this.channel.send(text);
    } catch {
      return false;
    }
    return true;
  }

  /** Transfer-channel send. False (not queued) unless open — the exchange
   *  engine treats a refused send as the channel dying under it (parks).
   *  Same throw-to-false guard as send(): the closing race exists on this
   *  channel too, and parking is exactly the right response to it. */
  sendXfer(data: string | ArrayBuffer): boolean {
    if (this.xfer.readyState !== "open") return false;
    try {
      this.xfer.send(data as string); // TS overload appeasement; runtime handles both
    } catch {
      return false;
    }
    return true;
  }

  xferBufferedAmount(): number {
    return this.xfer.bufferedAmount;
  }
}
