// Dual-tone sync mark: synthesis + sample-accurate matched-filter detection.
//
// This is the runtime (.mjs, no TS) counterpart to `lib/podcast/toneMark.ts`.
// The constants below MUST equal that module's exactly — a unit test imports
// both and asserts equality so drift is impossible. See toneMark.ts for the
// rationale (non-harmonic frequency pair above the speech-formant band, so
// voice energy can't fake it).
//
// Detection method (spec 5C): (1) Goertzel band energy at both TONE_FREQS
// over sliding 120ms frames, hop 10ms, gated against a total-energy floor;
// (2) group candidate frames into beeps, keep only beep pairs spaced
// 300ms +/- 30ms apart; (3) refine the coarse onset via full cross-
// correlation of `synthesizeMark()` against the pcm, +/- 60ms around the
// coarse guess, to sample accuracy.

import { DarkroomError } from "./errors.mjs";

export const TONE_FREQS = [1833, 2417];
export const BEEP_MS = 120;
export const BEEP_GAP_MS = 180;
export const MARK_TOTAL_MS = 2 * BEEP_MS + BEEP_GAP_MS; // 420
export const RAMP_S = 0.005;
export const SAMPLE_RATE = 48000;
export const SEARCH_WINDOW_S = 20;

const BEEP_S = BEEP_MS / 1000;
const GAP_S = BEEP_GAP_MS / 1000;

const FRAME_S = 0.12; // 120ms Goertzel analysis frame
const HOP_S = 0.01; // 10ms hop
const FRAME_LEN = Math.round(FRAME_S * SAMPLE_RATE);
const HOP_LEN = Math.round(HOP_S * SAMPLE_RATE);

const BAND_FLOOR_MULTIPLIER = 6;
const SPACING_TARGET_S = (BEEP_MS + BEEP_GAP_MS) / 1000; // 0.300
const SPACING_TOLERANCE_S = 0.03;
const REFINE_MARGIN_S = 0.06;

/** The two-beep sync mark schedule, in seconds, relative to its own start. */
function beepSchedule() {
  return [
    { start: 0, stop: BEEP_S },
    { start: BEEP_S + GAP_S, stop: 2 * BEEP_S + GAP_S },
  ];
}

/** Linear 0->0.5 ramp (RAMP_S), hold at 0.5, 0.5->0 ramp (RAMP_S). Mirrors
 * the gain-node automation in `scheduleToneMark`. */
function envelopeAt(t, start, stop) {
  if (t < start || t > stop) return 0;
  if (t < start + RAMP_S) return (0.5 * (t - start)) / RAMP_S;
  if (t > stop - RAMP_S) return (0.5 * (stop - t)) / RAMP_S;
  return 0.5;
}

/**
 * Synthesize the full dual-tone sync mark: two beeps, each
 * `env(t) * (sin(2*pi*f1*t) + sin(2*pi*f2*t))`, silence in the gap.
 * Length is exactly `MARK_TOTAL_MS/1000 * SAMPLE_RATE` samples.
 */
export function synthesizeMark() {
  const length = Math.round((MARK_TOTAL_MS / 1000) * SAMPLE_RATE);
  const out = new Float32Array(length);
  const beeps = beepSchedule();
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const { start, stop } of beeps) {
      const env = envelopeAt(t, start, stop);
      if (env === 0) continue;
      let carrier = 0;
      for (const freq of TONE_FREQS) carrier += Math.sin(2 * Math.PI * freq * t);
      sample += env * carrier;
    }
    out[i] = sample;
  }
  return out;
}

/** Generalized Goertzel power (== |X(omega)|^2) for one target frequency
 * over `pcm[offset, offset+FRAME_LEN)`. Works for non-integer DFT bins. */
function goertzelPower(pcm, offset, freq) {
  const omega = (2 * Math.PI * freq) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < FRAME_LEN; i++) {
    const s0 = pcm[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Per-frame band energies (normalized to the same scale as time-domain
 * sum-of-squares energy) plus the frame's total energy. */
function analyzeFrame(pcm, offset) {
  let total = 0;
  for (let i = 0; i < FRAME_LEN; i++) {
    const v = pcm[offset + i];
    total += v * v;
  }
  // Normalizing raw Goertzel power (which scales with FRAME_LEN^2 for a
  // coherent tone) by FRAME_LEN/2 puts it on the same linear-in-N scale as
  // the time-domain sum-of-squares energy above, so the two are comparable.
  const bands = TONE_FREQS.map((freq) => (goertzelPower(pcm, offset, freq) * 2) / FRAME_LEN);
  return { total, bands };
}

/** True if BOTH bands clear 6x the frame's non-band ("floor") energy —
 * voice/noise can't fake this narrow non-harmonic pair. */
function isCandidateFrame(pcm, offset) {
  const { total, bands } = analyzeFrame(pcm, offset);
  const floor = Math.max(0, total - bands[0] - bands[1]);
  return bands[0] > BAND_FLOOR_MULTIPLIER * floor && bands[1] > BAND_FLOOR_MULTIPLIER * floor;
}

/** Scan `[lo, hi)` of `pcm` with sliding Goertzel frames and group
 * consecutive candidate frames into beep onsets (sample index of each
 * beep's first candidate frame). */
function findBeepOnsets(pcm, lo, hi) {
  const onsets = [];
  let inRun = false;
  for (let offset = lo; offset + FRAME_LEN <= hi; offset += HOP_LEN) {
    const candidate = isCandidateFrame(pcm, offset);
    if (candidate && !inRun) {
      onsets.push(offset);
      inRun = true;
    } else if (!candidate) {
      inRun = false;
    }
  }
  return onsets;
}

/** Adjacent beep pairs whose onsets are 300ms +/- 30ms apart. */
function findValidPairs(onsets) {
  const pairs = [];
  for (let i = 0; i + 1 < onsets.length; i++) {
    const spacingS = (onsets[i + 1] - onsets[i]) / SAMPLE_RATE;
    if (Math.abs(spacingS - SPACING_TARGET_S) <= SPACING_TOLERANCE_S) {
      pairs.push(onsets[i]);
    }
  }
  return pairs;
}

/** Full cross-correlation of `synthesizeMark()` against `pcm`, +/- 60ms
 * around `coarseOnset`; returns the sample-accurate peak offset. */
function refineOnset(pcm, coarseOnset) {
  const template = synthesizeMark();
  const margin = Math.round(REFINE_MARGIN_S * SAMPLE_RATE);
  const lo = Math.max(0, coarseOnset - margin);
  const hi = Math.min(pcm.length - template.length, coarseOnset + margin);
  let best = lo;
  let bestScore = -Infinity;
  for (let offset = lo; offset <= hi; offset++) {
    let score = 0;
    for (let i = 0; i < template.length; i++) {
      score += template[i] * pcm[offset + i];
    }
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  return best;
}

/** Locate one mark inside `[lo, hi)`. `pick` selects which valid beep pair
 * is the genuine injected mark when more than one is found: "first" (the
 * earliest — used for the start-of-take window, since any acoustic
 * re-capture always follows the genuine digital injection) or "last" (the
 * latest — used for the end-of-take window, searched from its trailing
 * edge inward for the same reason). */
function locateMark(pcm, lo, hi, pick, missingCode) {
  const onsets = findBeepOnsets(pcm, lo, hi);
  if (onsets.length === 0) {
    throw new DarkroomError(missingCode, `no candidate beep in [${lo}, ${hi})`);
  }
  if (onsets.length === 1) {
    throw new DarkroomError("tone-one-beep", `only one beep found at sample ${onsets[0]}`);
  }
  const pairs = findValidPairs(onsets);
  if (pairs.length === 0) {
    throw new DarkroomError(missingCode, `no beep pair with valid 300ms spacing in [${lo}, ${hi})`);
  }
  const coarse = pick === "first" ? pairs[0] : pairs[pairs.length - 1];
  return refineOnset(pcm, coarse);
}

/**
 * Find the start and end sync marks in `pcm` (mono Float32Array).
 * Searches only `[0, SEARCH_WINDOW_S)` for the start mark and
 * `[len - SEARCH_WINDOW_S*SR, len)` for the end mark. Returns sample
 * indices of each mark's onset. Throws `DarkroomError` with code
 * `tone-start-missing` / `tone-end-missing` / `tone-one-beep`.
 */
export function findMarks(pcm) {
  const windowLen = SEARCH_WINDOW_S * SAMPLE_RATE;

  const startLo = 0;
  const startHi = Math.min(windowLen, pcm.length);
  const start = locateMark(pcm, startLo, startHi, "first", "tone-start-missing");

  const endLo = Math.max(0, pcm.length - windowLen);
  const endHi = pcm.length;
  const end = locateMark(pcm, endLo, endHi, "last", "tone-end-missing");

  return { start, end };
}
