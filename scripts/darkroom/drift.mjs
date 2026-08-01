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

/** ffmpeg audio filter that resamples the remote stream by `ratio`
 *  (ppm-scale, inaudible pitch shift) back to the local clock. */
export function remoteAudioFilter(ratio) {
  return `asetrate=${(SAMPLE_RATE * ratio).toFixed(3)},aresample=${SAMPLE_RATE}`;
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
