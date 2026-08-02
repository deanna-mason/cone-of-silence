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

/** `RTCRtpSender.prototype.createEncodedStreams` (the older Chrome-only
 * "Insertable Streams" shape) is checked FIRST; `RTCRtpScriptTransform`
 * (the newer, spec-track API) is the fallback. Neither present → null (the
 * caller's job, not this module's, to decide what null means — D15: a
 * themed refusal, never a silent plaintext call).
 *
 * D25 (2026-08-01, Deanna): this preference is INVERTED from script-
 * transform-first — deliberately, and only because of what Task 7's real-
 * browser e2e (e2e/phase5d-e2e.js) actually found, not a preference for
 * "older". `encoded-streams` is the branch that e2e proves end to end: two
 * real browsers, live video, VP9 pinned, decrypt genuinely running
 * continuously, a signaling kill+respawn rebuild, and an encrypted episode
 * exchange. `script-transform`'s RECEIVER side was observed to construct
 * cleanly, report no error, and then never invoke its transform callback for
 * a single frame — permanently — under chrome-headless-shell; it has no e2e
 * coverage anywhere in this codebase. Podcast mode (the only place E2EE
 * matters today) is Chrome-only and Chrome supports both APIs, so nothing is
 * lost by shipping the one with actual coverage; the fallback below is kept
 * live (and pinned by its own test) for a future browser that ships
 * script-transform without createEncodedStreams. If script-transform's
 * receiver-side behavior is later confirmed sound on real desktop Chrome
 * (the open question e2e/phase5d-e2e.js's header records for that
 * verification), this preference is a one-line, fully reversible flip back —
 * not a rewrite. lib/webrtc/e2ee.worker.ts's frame-flow timer (Task 7 review
 * round 2 — unrelated to lib/podcast/watchdog.ts's fault system despite
 * both once being called "watchdog") now backstops WHICHEVER branch is
 * live, including this fallback, so a future flip isn't flying blind
 * either. */
export function detectE2eeApi(): E2eeApi | null {
  // Review round 3 (one-token safety): `prototype` is typed optional here and
  // guarded at runtime — the ordering swap (D25) made this the FIRST,
  // unconditional dereference in the function, where it previously only ran
  // after a script-transform check had already returned early for any host
  // that also exposed RTCRtpScriptTransform. Not reachable from any real
  // browser (every real RTCRtpSender has a .prototype), but a host object
  // without one would otherwise throw here instead of falling through to the
  // script-transform check below.
  const sender = (globalThis as { RTCRtpSender?: { prototype?: object } }).RTCRtpSender;
  if (sender && sender.prototype && "createEncodedStreams" in sender.prototype) {
    return "encoded-streams";
  }
  if (typeof window !== "undefined" && "RTCRtpScriptTransform" in window) {
    return "script-transform";
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
