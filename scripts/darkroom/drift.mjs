// Drift math: audio is the sync reference. Both hosts inject the identical
// dual-tone mark at start and end of their own recording; the ratio of the
// two hosts' mark-to-mark spans is the remote clock's drift relative to the
// local clock, and the mark positions (once the remote is rate-corrected)
// give the residual start offset to align.
import { SAMPLE_RATE } from "./tone.mjs";

/**
 * driftRatio(localMarks, remoteMarks) → number
 *
 * The factor by which remote time must be scaled to match local time:
 * (local mark-to-mark span) / (remote mark-to-mark span).
 */
export function driftRatio(localMarks, remoteMarks) {
  const localSpan = localMarks.end - localMarks.start;
  const remoteSpan = remoteMarks.end - remoteMarks.start;
  return localSpan / remoteSpan;
}

/**
 * ffmpeg audio filter that resamples the remote stream by `ratio`
 * (ppm-scale, inaudible pitch shift) back to the local clock.
 *
 * D23 (controller ruling, Task 6 review round — CRITICAL 2): this divides
 * by `ratio`, not multiplies. `ratio = localSpan/remoteSpan`; a `ratio > 1`
 * means the remote span was SHORTER than local's for the same real-time
 * interval, i.e. remote's clock ran fast and its audio must be STRETCHED
 * (played back slower) to occupy local's longer duration. `asetrate=R`
 * reinterprets the sample rate as `R`, which changes duration to
 * `original/R` — so `R` must be BELOW the nominal rate to stretch (lengthen)
 * the audio: `R = SAMPLE_RATE/ratio` gives corrected duration
 * `original*(SAMPLE_RATE/R) = original*ratio`, converging on local's span.
 * The earlier `SAMPLE_RATE*ratio` form did the opposite — it COMPRESSED an
 * already-short remote track further, doubling the drift instead of
 * correcting it. `remoteVideoSetpts` below (`PTS*ratio`, unchanged) already
 * had the right direction; this fix brings audio into agreement with it —
 * see darkroom-drift.test.ts's direction-pinning test, which derives both
 * filters from the same ratio and asserts they converge together.
 */
export function remoteAudioFilter(ratio) {
  return `asetrate=${(SAMPLE_RATE / ratio).toFixed(3)},aresample=${SAMPLE_RATE}`;
}

/** ffmpeg video filter that scales PTS by the same `ratio`, so the remote
 *  video tracks its own host's rate-corrected audio. */
export function remoteVideoSetpts(ratio) {
  return `setpts=PTS*${ratio.toFixed(9)}`;
}

/**
 * alignment(localStartSample, remoteStartSampleCorrected) → {delayMs, who}
 *
 * Whichever start mark comes EARLIER (the smaller sample index) gets a
 * positive delay so both marks land on the same output timestamp. `who`
 * names which side that delay applies to.
 */
export function alignment(localStartSample, remoteStartSampleCorrected) {
  const diff = localStartSample - remoteStartSampleCorrected; // >0 => remote earlier
  const who = diff >= 0 ? "remote" : "local";
  const delaySamples = Math.abs(diff);
  const delayMs = Number(((delaySamples / SAMPLE_RATE) * 1000).toFixed(3));
  return { delayMs, who };
}
