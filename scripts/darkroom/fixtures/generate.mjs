#!/usr/bin/env node
// Fixture generator (provenance only — run ONCE, its OUTPUT is what's
// committed under scripts/darkroom/fixtures/episode-fix0{1,2}/; the e2e
// runs those committed bytes, never this script). Builds two complete
// two-host take dirs with real tone marks, real opus/vp8 media (real
// ffmpeg), and a `truth.json` ground-truth file per fixture computed
// directly from the generation parameters below — never from running the
// darkroom pipeline itself (that would make truth.json circular: "the
// pipeline is right because it agrees with itself").
//
// TWO fixtures, not one (Task 7 review round 2 — COVERAGE requirement):
// episode-fix01 has `who: "remote"` (remote's mark comes earlier, gets
// delayed); episode-fix02 has `who: "local"` (mirror image — local's mark
// comes earlier, LOCAL gets delayed). The e2e runs BOTH through the real
// watcher + developEpisode + compositeArgs, because a composite.mjs bug
// that only manifests in one direction (exactly what happened: round 1's
// fix pinned mp4 duration to whichever side was SHORTER, not to local
// specifically — see composite.mjs's doc comment and task-7-report.md's
// fix-report addendum) is invisible to a gate that only ever exercises one
// offset sign.
//
// Two brief-text corrections made for episode-fix01, both logged in
// task-7-report.md:
//
// 1. Directory/episodeId suffix: the brief's literal `take-20260101-0000-
//    fix1` is NOT a valid take dir name — vault.mjs's TAKE_DIR_RE requires
//    the last 4 chars to be `[0-9a-f]{4}` (hex), and 'i'/'x' aren't hex
//    digits. scanVault() would silently skip it, so the watcher (check 1)
//    would never fire. Uses `fee1` instead (hex-valid: f,e,e,1); fix02
//    uses `fee2` for the same reason.
//
// 2. Remote mark timing: the brief's literal "marks at 1.000s and 5.1990s"
//    (a 4-decimal rounding) implies a remote span of 4.199s, giving
//    ratio = 4.200/4.199 = 1.000238... — about 238 ppm off the stated
//    "ratio 1.0002" target, an order of magnitude past the e2e's own ±5ppm
//    gate. The actual sample-accurate span for ratio 1.0002 is
//    localSpan/1.0002 = 201600/1.0002 = 201559.688 samples, rounded to the
//    nearest sample (201560, shared by both fixtures) — which recovers a
//    ratio only ~1.6 ppm off target.
//
// Offset/residual tuning: each fixture's non-local mark position is chosen
// (not the round "0.75s"/"1.25s" it's near) so alignment()'s computed
// delayMs lands within a few microseconds of a WHOLE millisecond. `adelay`
// only has integer-millisecond resolution, and at the 2417Hz tone band a
// half-millisecond of unmodeled residual is more than a full cycle — a
// careless offset choice left an early draft of fixture 1 with one tone
// band's SNR just under the matched-filter's 6x gate purely from residual
// sub-ms phase cancellation between the two hosts' copies, nothing to do
// with drift correction actually being wrong. See each fixture's REMOTE_
// START/LOCAL_START comment for its specific chosen value.
// Note on re-running this script: the synthesized PCM content (noise bed +
// injected marks) and every truth.json field are fully deterministic (a
// seeded LCG only, no Date.now/Math.random) — but ffmpeg's own webm/
// matroska muxer stamps a wall-clock DateUTC (and a per-mux random Segment
// UID) into each container's header REGARDLESS of our input, so re-running
// this generator produces a fixture with the identical decoded audio/video
// content and identical truth.json numbers, but NOT necessarily
// byte-identical committed files (confirmed: re-running produced a 16-byte
// diff in fixture 1's audio.part000, isolated to two 8-byte fields via
// `cmp -l`, consistent with a muxer timestamp). This is fine for this
// generator's actual job — the COMMITTED bytes are the source of truth the
// e2e runs against, per the plan's "run once, then commit" instruction; the
// script itself is kept for provenance/documentation, not as a
// reproducible-build guarantee.
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { synthesizeMark, findMarks, SAMPLE_RATE } from "../tone.mjs";
import { makeRunner } from "../runner.mjs";
import { decodePcm } from "../decode.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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

const NOISE_AMPLITUDE = 0.02;
const HEADROOM = 0.9; // keeps injected-mark peaks + noise floor under +/-1.0 before opus encode

function buildTrack(length, seed, marks) {
  const track = noiseBed(length, seed, NOISE_AMPLITUDE);
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

async function encodeVideo(outPath, trackS) {
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
    `testsrc=size=320x180:rate=30:duration=${trackS}`,
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

/**
 * Builds one complete fixture take dir + its own truth.json.
 *
 * `cfg`: { dirName, takeId, completedAt, trackS, local: {start,end,seed},
 * remote: {start,end,seed,trackS?} } — all sample positions are absolute
 * generation parameters; nothing here is derived by running the pipeline.
 */
async function buildFixture(cfg) {
  const fixRoot = path.join(SCRIPT_DIR, cfg.dirName);
  const takeDir = path.join(fixRoot, cfg.takeId);
  const remoteDir = path.join(takeDir, "remote");

  await fsp.rm(fixRoot, { recursive: true, force: true });
  await fsp.mkdir(remoteDir, { recursive: true });

  const localSamples = Math.round(cfg.trackS * SAMPLE_RATE);
  const remoteTrackS = cfg.remote.trackS ?? cfg.trackS;
  const remoteSamples = Math.round(remoteTrackS * SAMPLE_RATE);

  console.log(
    `generating ${cfg.dirName}: local marks ${cfg.local.start}/${cfg.local.end}, ` +
      `remote marks ${cfg.remote.start}/${cfg.remote.end}, ratio ${cfg.ratio}`,
  );

  const localAudioPcm = buildTrack(localSamples, cfg.local.seed, [cfg.local.start, cfg.local.end]);
  const remoteAudioPcm = buildTrack(remoteSamples, cfg.remote.seed, [cfg.remote.start, cfg.remote.end]);

  const localAudioWebm = path.join(takeDir, "local-audio.webm.tmp");
  const remoteAudioWebm = path.join(takeDir, "remote-audio.webm.tmp");
  const localVideoWebm = path.join(takeDir, "local-video.webm.tmp");
  const remoteVideoWebm = path.join(takeDir, "remote-video.webm.tmp");

  await encodeAudio(localAudioPcm, localAudioWebm);
  await encodeAudio(remoteAudioPcm, remoteAudioWebm);
  await encodeVideo(localVideoWebm, cfg.trackS);
  await encodeVideo(remoteVideoWebm, remoteTrackS);

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
    console.log(
      `spot-check ${label}: found start=${start} (expected ${expectedStart}, delta ${dStart}), end=${end} (expected ${expectedEnd}, delta ${dEnd})`,
    );
    if (dStart > SPOT_CHECK_TOLERANCE || dEnd > SPOT_CHECK_TOLERANCE) {
      throw new Error(`${label}: opus round-trip moved a mark by more than ${SPOT_CHECK_TOLERANCE} samples`);
    }
  }
  await spotCheck(`${cfg.dirName}/local`, localAudioWebm, cfg.local.start, cfg.local.end);
  await spotCheck(`${cfg.dirName}/remote`, remoteAudioWebm, cfg.remote.start, cfg.remote.end);

  const localAudioEntries = await writeParts(takeDir, "audio", await fsp.readFile(localAudioWebm));
  const localVideoEntries = await writeParts(takeDir, "video", await fsp.readFile(localVideoWebm));
  const remoteAudioEntries = await writeParts(remoteDir, "audio", await fsp.readFile(remoteAudioWebm));
  const remoteVideoEntries = await writeParts(remoteDir, "video", await fsp.readFile(remoteVideoWebm));

  // Local sidecars — real-vault-shaped (lib/podcast/vault.ts's PartWriter
  // writes these), for take-dir realism. The darkroom pipeline itself never
  // reads them (it reads local entries straight out of the manifest), so
  // this is provenance/realism only, not a functional dependency.
  await fsp.writeFile(
    path.join(takeDir, "audio.sidecar.json"),
    JSON.stringify({ base: "audio", parts: localAudioEntries }, null, 2),
  );
  await fsp.writeFile(
    path.join(takeDir, "video.sidecar.json"),
    JSON.stringify({ base: "video", parts: localVideoEntries }, null, 2),
  );

  const manifest = {
    version: 1,
    episodeId: cfg.takeId,
    receivedFrom: "NIGHTINGALE",
    completedAt: cfg.completedAt,
    local: { audio: localAudioEntries, video: localVideoEntries },
    remote: { audio: remoteAudioEntries, video: remoteVideoEntries },
  };
  await fsp.writeFile(path.join(takeDir, "episode.json"), JSON.stringify(manifest, null, 2));

  for (const f of [localAudioWebm, remoteAudioWebm, localVideoWebm, remoteVideoWebm]) {
    await fsp.rm(f, { force: true });
  }

  // ---- ground truth: computed from the generation parameters above ONLY. ----
  const expectedRemoteStartCorrected = cfg.remote.start * cfg.ratio;
  const diff = cfg.local.start - expectedRemoteStartCorrected; // >0 => remote earlier
  const expectedWho = diff >= 0 ? "remote" : "local";
  const expectedDelayMs = Number(((Math.abs(diff) / SAMPLE_RATE) * 1000).toFixed(3));

  const truth = {
    sampleRate: SAMPLE_RATE,
    local: {
      startSample: cfg.local.start,
      endSample: cfg.local.end,
      startS: cfg.local.start / SAMPLE_RATE,
      endS: cfg.local.end / SAMPLE_RATE,
      trackS: cfg.trackS,
    },
    remote: {
      startSample: cfg.remote.start,
      endSample: cfg.remote.end,
      startS: cfg.remote.start / SAMPLE_RATE,
      endS: cfg.remote.end / SAMPLE_RATE,
      trackS: remoteTrackS,
    },
    ratio: cfg.ratio,
    ratioTarget: cfg.ratioTarget,
    ratioDeviationPpm: (cfg.ratio - cfg.ratioTarget) * 1e6,
    expectedDelayMs,
    expectedWho,
    notes:
      "All fields above are computed directly from the sample positions this " +
      "generator injects synthesizeMark() at — never from running the darkroom " +
      "pipeline. ratio = localSpan/remoteSpan per drift.mjs's driftRatio " +
      "contract. expectedDelayMs/expectedWho mirror alignment()'s own " +
      "contract: diff = localStart - remoteStart*ratio; diff>=0 => who=remote.",
  };
  await fsp.writeFile(path.join(fixRoot, "truth.json"), JSON.stringify(truth, null, 2));

  console.log(`fixture generated: ${takeDir} (expectedWho=${expectedWho}, expectedDelayMs=${expectedDelayMs})`);
}

// ---- fixture 1: who === "remote" (remote's mark comes earlier; remote
// gets delayed). Unchanged since the first cut of this generator — see the
// module header for the ratio/offset derivation. ----
const LOCAL_SPAN_1 = 249600 - 48000;
const TARGET_RATIO = 1.0002;
const REMOTE_SPAN = Math.round(LOCAL_SPAN_1 / TARGET_RATIO); // 201560, shared by both fixtures
const RATIO = LOCAL_SPAN_1 / REMOTE_SPAN;

const FIXTURE_1 = {
  dirName: "episode-fix01",
  takeId: "take-20260101-0000-fee1",
  completedAt: "2026-01-01T00:10:00.000Z",
  trackS: 6.0,
  ratio: RATIO,
  ratioTarget: TARGET_RATIO,
  local: { start: 48000, end: 249600, seed: 0xc0de1 }, // 1.000s / 5.200s
  // 35993, not the rounder 36000 (~0.750s): chosen so alignment()'s
  // computed delayMs lands within ~0.003ms of a whole millisecond (see
  // module header). 35993/48000 = 0.749854s.
  remote: { start: 35993, end: 35993 + REMOTE_SPAN, seed: 0xc0de2 },
};

// ---- fixture 2: who === "local" (mirror image — local's mark comes
// earlier; LOCAL gets delayed). New in Task 7 review round 2 (COVERAGE):
// exercises the composite.mjs code path the round-1 duration-pin fix got
// backwards (see composite.mjs's doc comment). Same local marks/ratio as
// fixture 1; only the "which side has the bigger lead-in" is flipped. ----
const FIXTURE_2 = {
  dirName: "episode-fix02",
  takeId: "take-20260101-0001-fee2",
  completedAt: "2026-01-01T00:11:00.000Z",
  trackS: 6.0,
  ratio: RATIO,
  ratioTarget: TARGET_RATIO,
  local: { start: 48000, end: 249600, seed: 0xfee1a }, // same local marks as fixture 1
  // 59988, not the rounder 60000 (~1.250s): chosen the same way as
  // fixture 1's 35993 — alignment()'s computed delayMs (249.998ms) lands
  // within ~0.002ms of a whole millisecond. 59988/48000 = 1.249750s.
  // trackS deliberately matches local's 6.0s (not padded out, ~0.13s tail
  // margin after the end mark) rather than a safer-but-longer track: this
  // is the specific shape that exposes the round-1 composite bug — with
  // BOTH raw tracks the same 6.0s length, local's OWN 250ms delay is what
  // makes its chain (6.25s) longer than remote's (6.0s), so a duration-pin
  // mechanism that secretly picks "whichever side is shorter" instead of
  // "local specifically" fails on exactly this case (reviewer's own repro:
  // "remote chain shorter even with EQUAL recordings").
  remote: { start: 59988, end: 59988 + REMOTE_SPAN, seed: 0xfee2b },
};

async function main() {
  await buildFixture(FIXTURE_1);
  await buildFixture(FIXTURE_2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
