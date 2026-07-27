// lib/audioLevel.ts
// Pure speech-level math for the speaking indicator (Phase 4C) — kept free
// of WebAudio objects so the threshold logic unit-tests without a browser.

/** RMS threshold above which a remote stream counts as "speaking". */
export const SPEAKING_THRESHOLD = 0.04;
/** Poll cadence (~10 Hz) — four analysers stay far below a frame budget. */
export const SPEAKING_POLL_MS = 100;

/** RMS of a getByteTimeDomainData buffer (silence = 128 → 0.0). */
export function rmsFromTimeDomain(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (const b of bytes) {
    const centered = (b - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / bytes.length);
}

export function isSpeaking(bytes: Uint8Array, threshold = SPEAKING_THRESHOLD): boolean {
  return rmsFromTimeDomain(bytes) >= threshold;
}
