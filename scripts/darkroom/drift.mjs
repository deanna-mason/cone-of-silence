// Drift math: audio is the sync reference. Both hosts inject the identical
// dual-tone mark at start and end of their own recording; the ratio of the
// two hosts' mark-to-mark spans is the remote clock's drift relative to the
// local clock, and the mark positions (once the remote is rate-corrected)
// give the residual start offset to align.
import { SAMPLE_RATE, MARK_TOTAL_MS } from "./tone.mjs";
import { DarkroomError } from "./errors.mjs";

/**
 * Pad kept on each side of the episode chime trim, in milliseconds
 * (design 2026-08-05, decision 1 — deliberately NOT configurable: no CLI
 * flag, no manifest field).
 *
 * Chosen over a tight cut at the mark boundaries: an open-speakers take can
 * re-capture its own chime acoustically just inside the cut, and the 8/5
 * rehearsal-take measurement put that bleed at ~465ms. Chosen over a 1s pad,
 * which risks clipping a first word.
 */
export const PAD_MS = 250;

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

/**
 * episodeWindow(localMarks, localDelayMs) → {startS, endS}
 *
 * The episode chime trim's one window (design 2026-08-05): what survives
 * into `episode.m4a`/`episode.mp4` once the marks — and the "are we
 * rolling?" shuffle before them and the Cut click after them — are cut off.
 *
 * Derived from LOCAL only, on purpose. Both hosts inject the identical mark
 * into their own recording, and after `driftRatio` rate-correction plus
 * `alignment`'s per-side `adelay` those marks land on the SAME instant of
 * the mixed timeline — so local, the side the rest of this pipeline already
 * treats as the reference (remote is the one that gets rate-corrected), is
 * enough to place the cut for both sides. `localDelayMs` moves the window
 * onto that common post-delay timeline (it is 0 whenever remote is the
 * delayed side).
 *
 *   startS = (markStartMs + MARK_TOTAL_MS + PAD_MS) / 1000
 *   endS   = (markEndMs   - PAD_MS) / 1000
 *
 * The asymmetry in those two lines is not a slip: `localMarks.start` and
 * `localMarks.end` are BOTH mark ONSETS (locateMark returns refineOnset),
 * so the head must skip past the start mark's whole 420ms body before
 * padding, while the tail pads backwards from the end mark's onset — which
 * is already its earliest sounding sample. Neither mark can survive.
 *
 * Refuses (rather than silently emitting an empty episode) when the marks
 * are closer together than MARK_TOTAL_MS + 2*PAD_MS = 920ms — real takes
 * are minutes long, so this only ever catches sub-1.5s junk takes. The
 * comparison is on exact seconds, never a rounded-to-ms value: a window one
 * sample wide is degenerate but real, and it is not this function's job to
 * decide it is too small to keep.
 */
export function episodeWindow(localMarks, localDelayMs) {
  const markStartMs = (localMarks.start / SAMPLE_RATE) * 1000 + localDelayMs;
  const markEndMs = (localMarks.end / SAMPLE_RATE) * 1000 + localDelayMs;

  const startS = (markStartMs + MARK_TOTAL_MS + PAD_MS) / 1000;
  const endS = (markEndMs - PAD_MS) / 1000;

  if (endS <= startS) {
    throw new DarkroomError(
      "trim-window-empty",
      `marks are ${(markEndMs - markStartMs).toFixed(3)}ms apart, less than the ` +
        `${MARK_TOTAL_MS + 2 * PAD_MS}ms the mark bodies plus ${PAD_MS}ms of pad on each side need — ` +
        "trimming would leave nothing",
    );
  }

  return { startS, endS };
}
