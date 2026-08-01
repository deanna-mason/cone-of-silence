// lib/webrtc/e2eeSupport.ts
// Phase 5D: feature-detect which of Chrome's two competing encoded-transform
// APIs this browser exposes, and pin the video codec E2EE requires. Both
// functions are pure (no pc, no worker) so they're unit-testable in jsdom
// with plain global stubs — see docs/superpowers/plans/2026-08-01-phase-5d-e2ee.md
// Global Constraints (Codec pin) for why VP9 is mandatory once E2EE is on:
// the H.264 packetizer inspects frame contents (NAL unit structure) to split
// a frame across RTP packets, which an opaque encrypted blob defeats; VP9's
// packetizer does not need to parse the payload.

export type E2eeApi = "script-transform" | "encoded-streams";

/** `RTCRtpScriptTransform` (the modern, spec-track API) is checked first;
 * `RTCRtpSender.prototype.createEncodedStreams` (the older Chrome-only
 * "Insertable Streams" shape) is the fallback. Neither present → null (the
 * caller's job, not this module's, to decide what null means — D15: a
 * themed refusal, never a silent plaintext call). */
export function detectE2eeApi(): E2eeApi | null {
  if (typeof window !== "undefined" && "RTCRtpScriptTransform" in window) {
    return "script-transform";
  }
  const sender = (globalThis as { RTCRtpSender?: { prototype: object } }).RTCRtpSender;
  if (sender && "createEncodedStreams" in sender.prototype) {
    return "encoded-streams";
  }
  return null;
}

const KEPT_AUX_CODECS = new Set(["video/rtx", "video/red", "video/ulpfec"]);

/** VP9 first (required — see module doc), then whichever of rtx/red/ulpfec
 * the platform advertises (preserving retransmission/FEC), everything else
 * dropped. Null when the platform has no VP9 codec at all — the caller
 * skips `setCodecPreferences` rather than pinning to an empty list (an
 * empty preference list is not "no preference", it's "no codecs allowed"). */
export function vp9Preferences(caps: RTCRtpCapabilities | null): RTCRtpCodec[] | null {
  if (!caps) return null;
  const vp9 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === "video/vp9");
  if (vp9.length === 0) return null;
  const aux = caps.codecs.filter((c) => KEPT_AUX_CODECS.has(c.mimeType.toLowerCase()));
  return [...vp9, ...aux];
}
