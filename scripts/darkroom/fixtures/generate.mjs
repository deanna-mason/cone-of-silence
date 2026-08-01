#!/usr/bin/env node
// Fixture generator (provenance only — run ONCE, its OUTPUT is what's
// committed under scripts/darkroom/fixtures/episode-fix01/; the e2e runs
// those committed bytes, never this script). Builds a complete two-host
// take dir with real tone marks, real opus/vp8 media (real ffmpeg), and a
// `truth.json` ground-truth file computed directly from the generation
// parameters below — never from running the darkroom pipeline itself (that
// would make truth.json circular: "the pipeline is right because it agrees
// with itself").
//
// Two brief-text corrections made here, both logged in task-7-report.md:
//
// 1. Directory/episodeId suffix: the brief's literal `take-20260101-0000-
//    fix1` is NOT a valid take dir name — vault.mjs's TAKE_DIR_RE requires
//    the last 4 chars to be `[0-9a-f]{4}` (hex), and 'i'/'x' aren't hex
//    digits. scanVault() would silently skip it, so the watcher (check 1)
//    would never fire. Uses `fee1` instead (hex-valid: f,e,e,1).
//
// 2. Remote mark timing: the brief's literal "marks at 1.000s and 5.1990s"
//    (a 4-decimal rounding) implies a remote span of 4.199s, giving
//    ratio = 4.200/4.199 = 1.000238... — about 238 ppm off the stated
//    "ratio 1.0002" target, an order of magnitude past the e2e's own ±5ppm
//    gate. The actual sample-accurate span for ratio 1.0002 is
//    localSpan/1.0002 = 201600/1.0002 = 201559.688 samples, rounded to the
//    nearest sample (201560) — see REMOTE_SPAN below — which recovers a
//    ratio only ~1.6 ppm off target. The end mark this places is
//    ~5.19917s, not 5.1990s; that's the number actually generated and
//    recorded in truth.json.
//
// Offset: remote's start mark sits at 0.750s in its own file (vs. local's
// 1.000s) — a genuine 250ms-class offset for alignment() to correct, not
// just the ~0.2ms the ratio scaling alone would produce. After ratio
// correction this resolves to a ~249.85ms delay applied to remote (see the
// computed truth.expectedDelayMs/expectedWho below) — close to, but not
// exactly, "250ms" by design: the ratio scaling itself contributes a small
// residual, and that residual being present-and-small is itself part of
// what the e2e's alignment check is proving.
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { synthesizeMark, findMarks, SAMPLE_RATE } from "../tone.mjs";
import { makeRunner } from "../runner.mjs";
import { decodePcm } from "../decode.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX_ROOT = path.join(SCRIPT_DIR, "episode-fix01");
const TAKE_ID = "take-20260101-0000-fee1";
const TAKE_DIR = path.join(FIX_ROOT, TAKE_ID);
const REMOTE_DIR = path.join(TAKE_DIR, "remote");

const TRACK_S = 6.0;
const TRACK_SAMPLES = Math.round(TRACK_S * SAMPLE_RATE); // 288000

// ---- ground-truth generation parameters — the ONLY source of truth.json's
// numbers. Nothing below this block is derived by running the pipeline. ----
const LOCAL_START = Math.round(1.0 * SAMPLE_RATE); // 48000 (1.000s)
const LOCAL_END = Math.round(5.2 * SAMPLE_RATE); // 249600 (5.200s)
const LOCAL_SPAN = LOCAL_END - LOCAL_START; // 201600

const TARGET_RATIO = 1.0002; // 200ppm fast remote clock (spec)
const REMOTE_SPAN = Math.round(LOCAL_SPAN / TARGET_RATIO); // 201560
// 35993, not the rounder 36000 (~0.750s): chosen so the delay alignment()
// computes lands within a few microseconds of a WHOLE millisecond (see
// task-7-report.md's "adelay granularity" note) — adelay's own resolution
// is integer milliseconds, and at the 2417Hz tone band a half-millisecond
// of unmodeled residual is more than a full cycle, so a careless offset
// choice can leave the two hosts' end-to-end mixed copies of the mark
// PARTIALLY destructively interfering even though the alignment math is
// exactly correct. 35993 keeps that residual under 0.01ms (~0.4 samples),
// negligible at both tone frequencies, while still sitting close to the
// spec's "~250ms offset" (35993 samples = 0.749854s, i.e. still "0.750s"
// to 3 decimals).
const REMOTE_START = 35993;
const REMOTE_END = REMOTE_START + REMOTE_SPAN;

const RATIO = LOCAL_SPAN / REMOTE_SPAN; // the ACTUAL ratio these sample positions encode

const NOISE_AMPLITUDE = 0.02;
const HEADROOM = 0.9; // keeps injected-mark peaks + noise floor under +/-1.0 before opus encode

function seededLcg(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296; // [0, 1)
  };
}

/** Deterministic "speech-band-ish" hiss: a seeded LCG through a gentle
 *  one-pole low-pass, giving it a pink-ish tilt rather than flat white
 *  noise. No Date.now/Math.random anywhere — same seed always produces the
 *  same bytes (required: the committed fixture must be reproducible). */
function noiseBed(length, seed, amplitude) {
  const next = seededLcg(seed);
  const out = new Float32Array(length);
  let state = 0;
  for (let i = 0; i < length; i++) {
    const white = next() * 2 - 1;
    state = 0.98 * state + 0.02 * white;
    out[i] = state * amplitude;
  }
  return out;
}

function injectMark(track, startSample) {
  const mark = synthesizeMark();
  for (let i = 0; i < mark.length; i++) track[startSample + i] += mark[i];
}

function buildTrack(seed, marks) {
  const track = noiseBed(TRACK_SAMPLES, seed, NOISE_AMPLITUDE);
  for (const at of marks) injectMark(track, at);
  for (let i = 0; i < track.length; i++) track[i] *= HEADROOM;
  return track;
}

function floatsToF32LE(track) {
  const buf = Buffer.alloc(track.length * 4);
  for (let i = 0; i < track.length; i++) buf.writeFloatLE(track[i], i * 4);
  return buf;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

async function encodeAudio(pcm, outPath) {
  const rawPath = `${outPath}.raw`;
  await fsp.writeFile(rawPath, floatsToF32LE(pcm));
  try {
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "f32le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      rawPath,
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-f",
      "webm",
      outPath,
    ]);
  } finally {
    await fsp.rm(rawPath, { force: true });
  }
}

async function encodeVideo(outPath) {
  // testsrc's own built-in scrolling-gradient + timestamp burn-in requires
  // no drawtext/freetype (D10: this ffmpeg build has neither) — the source
  // filter renders its own counter with a hardcoded bitmap font.
  await run("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x180:rate=30:duration=${TRACK_S}`,
    "-c:v",
    "libvpx",
    "-b:v",
    "200k",
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-f",
    "webm",
    outPath,
  ]);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Splits `buf` into 3 parts at arbitrary (non-uniform, container-agnostic)
 *  byte offsets. Byte-concat of the parts in order reconstructs `buf`
 *  EXACTLY regardless of where the cuts land — concat.mjs's reassemble()
 *  never needs a split point to respect WebM cluster/frame boundaries, so
 *  cutting a fully-muxed file at arbitrary offsets is a faithful stand-in
 *  for MediaRecorder's own timeslice chunking (see task-7-report.md). */
function splitThree(buf) {
  const a = Math.floor(buf.length * 0.37);
  const b = Math.floor(buf.length * 0.71);
  return [buf.subarray(0, a), buf.subarray(a, b), buf.subarray(b)];
}

async function writeParts(dir, base, buf) {
  await fsp.mkdir(dir, { recursive: true });
  const parts = splitThree(buf);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const name = `${base}.part${String(i).padStart(3, "0")}`;
    await fsp.writeFile(path.join(dir, name), parts[i]);
    entries.push({ name, size: parts[i].length, sha256: sha256(parts[i]) });
  }
  return entries;
}

async function main() {
  await fsp.rm(FIX_ROOT, { recursive: true, force: true });
  await fsp.mkdir(REMOTE_DIR, { recursive: true });

  console.log(`generating: local marks ${LOCAL_START}/${LOCAL_END} (span ${LOCAL_SPAN}), ` +
    `remote marks ${REMOTE_START}/${REMOTE_END} (span ${REMOTE_SPAN}), ratio ${RATIO}`);

  const localAudioPcm = buildTrack(0xc0de1, [LOCAL_START, LOCAL_END]);
  const remoteAudioPcm = buildTrack(0xc0de2, [REMOTE_START, REMOTE_END]);

  const localAudioWebm = path.join(TAKE_DIR, "local-audio.webm.tmp");
  const remoteAudioWebm = path.join(TAKE_DIR, "remote-audio.webm.tmp");
  const localVideoWebm = path.join(TAKE_DIR, "local-video.webm.tmp");
  const remoteVideoWebm = path.join(TAKE_DIR, "remote-video.webm.tmp");

  await encodeAudio(localAudioPcm, localAudioWebm);
  await encodeAudio(remoteAudioPcm, remoteAudioWebm);
  await encodeVideo(localVideoWebm);
  await encodeVideo(remoteVideoWebm);

  // ---- generation-time consistency spot-check (NOT the ground truth
  // itself — a sanity net that the real opus encode round-trip hasn't
  // smeared the marks away from the analytic positions above by more than a
  // couple of samples, catching a clipping/headroom mistake here rather
  // than deep in the e2e). truth.json's fields below are still written from
  // the analytic parameters regardless of what this finds. ----
  const runner = makeRunner("ffmpeg");
  const SPOT_CHECK_TOLERANCE = 4; // samples — generous; the e2e's own gate is +/-1 on the FULL pipeline's raw/ copy
  async function spotCheck(label, webmPath, expectedStart, expectedEnd) {
    const pcm = await decodePcm(runner, webmPath);
    const { start, end } = findMarks(pcm);
    const dStart = Math.abs(start - expectedStart);
    const dEnd = Math.abs(end - expectedEnd);
    console.log(`spot-check ${label}: found start=${start} (expected ${expectedStart}, delta ${dStart}), end=${end} (expected ${expectedEnd}, delta ${dEnd})`);
    if (dStart > SPOT_CHECK_TOLERANCE || dEnd > SPOT_CHECK_TOLERANCE) {
      throw new Error(`${label}: opus round-trip moved a mark by more than ${SPOT_CHECK_TOLERANCE} samples`);
    }
  }
  await spotCheck("local", localAudioWebm, LOCAL_START, LOCAL_END);
  await spotCheck("remote", remoteAudioWebm, REMOTE_START, REMOTE_END);

  const localAudioEntries = await writeParts(TAKE_DIR, "audio", await fsp.readFile(localAudioWebm));
  const localVideoEntries = await writeParts(TAKE_DIR, "video", await fsp.readFile(localVideoWebm));
  const remoteAudioEntries = await writeParts(REMOTE_DIR, "audio", await fsp.readFile(remoteAudioWebm));
  const remoteVideoEntries = await writeParts(REMOTE_DIR, "video", await fsp.readFile(remoteVideoWebm));

  // Local sidecars — real-vault-shaped (lib/podcast/vault.ts's PartWriter
  // writes these), for take-dir realism. The darkroom pipeline itself never
  // reads them (it reads local entries straight out of the manifest), so
  // this is provenance/realism only, not a functional dependency.
  await fsp.writeFile(
    path.join(TAKE_DIR, "audio.sidecar.json"),
    JSON.stringify({ base: "audio", parts: localAudioEntries }, null, 2),
  );
  await fsp.writeFile(
    path.join(TAKE_DIR, "video.sidecar.json"),
    JSON.stringify({ base: "video", parts: localVideoEntries }, null, 2),
  );

  const manifest = {
    version: 1,
    episodeId: TAKE_ID,
    receivedFrom: "NIGHTINGALE",
    completedAt: "2026-01-01T00:10:00.000Z",
    local: { audio: localAudioEntries, video: localVideoEntries },
    remote: { audio: remoteAudioEntries, video: remoteVideoEntries },
  };
  await fsp.writeFile(path.join(TAKE_DIR, "episode.json"), JSON.stringify(manifest, null, 2));

  for (const f of [localAudioWebm, remoteAudioWebm, localVideoWebm, remoteVideoWebm]) {
    await fsp.rm(f, { force: true });
  }

  // ---- ground truth: computed from the generation parameters above ONLY. ----
  const expectedRemoteStartCorrected = REMOTE_START * RATIO;
  const diff = LOCAL_START - expectedRemoteStartCorrected; // >0 => remote earlier
  const expectedWho = diff >= 0 ? "remote" : "local";
  const expectedDelayMs = Number(((Math.abs(diff) / SAMPLE_RATE) * 1000).toFixed(3));

  const truth = {
    sampleRate: SAMPLE_RATE,
    local: {
      startSample: LOCAL_START,
      endSample: LOCAL_END,
      startS: LOCAL_START / SAMPLE_RATE,
      endS: LOCAL_END / SAMPLE_RATE,
    },
    remote: {
      startSample: REMOTE_START,
      endSample: REMOTE_END,
      startS: REMOTE_START / SAMPLE_RATE,
      endS: REMOTE_END / SAMPLE_RATE,
    },
    ratio: RATIO,
    ratioTarget: TARGET_RATIO,
    ratioDeviationPpm: (RATIO - TARGET_RATIO) * 1e6,
    expectedDelayMs,
    expectedWho,
    notes:
      "All fields above are computed directly from the sample positions this " +
      "generator injects synthesizeMark() at — never from running the darkroom " +
      "pipeline. ratio = localSpan/remoteSpan per drift.mjs's driftRatio " +
      "contract. expectedDelayMs/expectedWho mirror alignment()'s own " +
      "contract: diff = localStart - remoteStart*ratio; diff>=0 => who=remote.",
  };
  await fsp.writeFile(path.join(FIX_ROOT, "truth.json"), JSON.stringify(truth, null, 2));

  console.log("fixture generated:", TAKE_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
