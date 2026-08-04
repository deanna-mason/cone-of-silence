// Studio-parity enhancement chain + measured (two-pass) loudnorm + mix
// builders. This is the pinned parity surface (see the plan's Global
// Constraints "Parity invariant"): `chainFilter` and the constant embedded
// in `LOUDNORM_TARGET` must be byte-for-byte what the Studio path
// (`server/src/studio/ffmpegArgs.ts`) uses for a stem's enhancement chain.
//
// `LOUDNORM_TARGET` is a module-private (non-exported) const over there, so
// it can't be pinned by a live import directly — __tests__/darkroom-chain.
// test.ts pins it two ways instead: (1) a live-import parity check on the
// exported `measureArgs`, whose -af string embeds this constant character-
// for-character, and (2) a source-text extraction of the literal from
// ffmpegArgs.ts. Both must stay in lockstep with this file (D20).
//
// server/src/studio/ffmpegArgs.ts's own `applyArgs` carries only four
// measured_* fields (I, TP, LRA, thresh) — no `offset=`. That's a property
// of the Studio's single-pass voice-note flow, not part of the pinned
// parity invariant (which is scoped to the chain + LOUDNORM_TARGET only).
// The darkroom's own measured-apply format below follows the brief's
// interface spec and ffmpeg's documented two-pass loudnorm usage, which
// does carry `offset=` (from the measured `target_offset`) — a superset,
// not a mismatch, of what the Studio does.
import { DarkroomError } from "./errors.mjs";

export const LOUDNORM_TARGET = "loudnorm=I=-16:TP=-1.5:LRA=11";

// The darkroom reassembles and enhances parts received from the remote peer,
// so its inputs are semi-untrusted. ffmpeg auto-detects format from content and
// some demuxers can open external file://,http:// resources — pin every input
// pass to local file + pipe only. Mirrors server ffmpegArgs.ts (S6 F1) and
// keeps the measure-pass argv parity with server.measureArgs intact.
const INPUT_PROTOCOLS = ["-protocol_whitelist", "file,pipe"];

/** Character-identical to server/src/studio/ffmpegArgs.ts chainFilter(). */
export function chainFilter(model) {
  return [
    "highpass=f=80",
    `arnndn=m=${model}`,
    "deesser=i=0.4",
    "acompressor=threshold=-18dB:ratio=3:attack=15:release=250:makeup=2",
    "equalizer=f=4000:width_type=o:width=1.2:g=2",
  ].join(",");
}

function chainWithExtra(model, extraFilter) {
  return extraFilter ? `${extraFilter},${chainFilter(model)}` : chainFilter(model);
}

/** Extracts the LAST `{...}` block in ffmpeg's stderr (loudnorm's measured
 * JSON summary) and validates it carries all five fields darkroom needs.
 * Missing/invalid JSON is an `ffmpeg-failed` refusal, matching the strict
 * "manifest-invalid"-style posture used elsewhere in the darkroom. */
function parseLoudnormStderr(stderr) {
  const matches = stderr.match(/\{[^{}]*\}/g);
  if (!matches || matches.length === 0) {
    throw new DarkroomError("ffmpeg-failed", "loudnorm measurement json not found in ffmpeg output");
  }
  const last = matches[matches.length - 1];
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new DarkroomError("ffmpeg-failed", "loudnorm measurement json in ffmpeg output is not valid JSON");
  }
  const pick = (key) => {
    const v = parsed[key];
    if (typeof v !== "string") {
      throw new DarkroomError("ffmpeg-failed", `loudnorm measurement json missing "${key}"`);
    }
    return v;
  };
  return {
    input_i: pick("input_i"),
    input_tp: pick("input_tp"),
    input_lra: pick("input_lra"),
    input_thresh: pick("input_thresh"),
    target_offset: pick("target_offset"),
  };
}

/**
 * measureStem(runner, input, model, extraFilter?) → Promise<Measurement>
 *
 * Argv mirrors server's measureArgs (ffmpegArgs.ts:19-25) exactly when
 * extraFilter is absent; extraFilter (the remote drift filter, e.g.
 * `asetrate=...,aresample=...`) is PREPENDED to the chain when present.
 */
export async function measureStem(runner, input, model, extraFilter) {
  const af = `${chainWithExtra(model, extraFilter)},${LOUDNORM_TARGET}:print_format=json`;
  const argv = ["-hide_banner", "-nostdin", ...INPUT_PROTOCOLS, "-i", input, "-af", af, "-f", "null", "-"];
  const { stderr } = await runner.run(argv);
  return parseLoudnormStderr(stderr);
}

/**
 * applyStemArgs(input, model, m, out, extraFilter?) → string[]
 *
 * Mirrors server's applyArgs (ffmpegArgs.ts:27-35) shape: chain + measured
 * loudnorm + aac 192k/48k output. Carries all five measured_* values
 * (including `offset=` from `target_offset`) plus `linear=true`.
 */
export function applyStemArgs(input, model, m, out, extraFilter) {
  const af =
    `${chainWithExtra(model, extraFilter)},${LOUDNORM_TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  return [
    "-hide_banner", "-nostdin", "-y", ...INPUT_PROTOCOLS, "-i", input, "-vn",
    "-af", af,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out,
  ];
}

function mixFilterComplex(delayFilterA, delayFilterB, tail) {
  return `[0:a]${delayFilterA}[da];[1:a]${delayFilterB}[db];[da][db]amix=inputs=2:normalize=0,${tail}`;
}

/**
 * mixMeasureArgs(a, b, delayFilterA, delayFilterB) → string[]
 *
 * Per-input `adelay` (Task 3's alignment) into `amix=inputs=2:normalize=0`,
 * then the measure pass of the mix's own two-pass loudnorm (D13).
 */
export function mixMeasureArgs(a, b, delayFilterA, delayFilterB) {
  const filterComplex = mixFilterComplex(delayFilterA, delayFilterB, `${LOUDNORM_TARGET}:print_format=json`);
  return [
    "-hide_banner", "-nostdin", ...INPUT_PROTOCOLS, "-i", a, ...INPUT_PROTOCOLS, "-i", b,
    "-filter_complex", filterComplex,
    "-f", "null", "-",
  ];
}

/**
 * mixApplyArgs(a, b, delayFilterA, delayFilterB, m, out) → string[]
 *
 * Same mix graph as mixMeasureArgs, applying the measured loudnorm and
 * encoding the final episode.m4a (aac 192k, 48kHz).
 */
export function mixApplyArgs(a, b, delayFilterA, delayFilterB, m, out) {
  const tail =
    `${LOUDNORM_TARGET}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const filterComplex = mixFilterComplex(delayFilterA, delayFilterB, tail);
  return [
    "-hide_banner", "-nostdin", "-y", ...INPUT_PROTOCOLS, "-i", a, ...INPUT_PROTOCOLS, "-i", b,
    "-filter_complex", filterComplex,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out,
  ];
}
