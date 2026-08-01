// e2e/darkroom-e2e.js
// Phase 5C acceptance: the darkroom's committed fixture episodes develop
// HANDS-OFF via the vault WATCHER (never --develop) against real ffmpeg and
// a real headless-Chrome backdrop render, with sample-accurate alignment
// verified against each fixture's own committed ground truth
// (scripts/darkroom/fixtures/episode-fix0{1,2}/truth.json), sources left
// byte-identical, a gap refusal, and a re-runnable --develop.
//
// TWO fixtures (Task 7 review round 2 — COVERAGE): episode-fix01 has
// `who: "remote"` (remote's mark comes earlier, remote gets delayed);
// episode-fix02 has `who: "local"` (mirror image — local's mark comes
// earlier, LOCAL gets delayed). Both go through the full watcher +
// developEpisode + compositeArgs real pipeline. This isn't belt-and-braces:
// a real composite.mjs duration-pin bug (see scripts/darkroom/composite.mjs's
// doc comment and task-7-report.md) shipped and passed review specifically
// BECAUSE the gate only ever exercised one offset sign — the fix for the
// first bug silently pinned mp4 duration to "whichever side is shorter"
// instead of "local specifically", which is invisible when local happens to
// be the shorter side (fixture 1's shape) and only shows up as content loss
// when local is longer (fixture 2's shape, the `who === "local"` half of
// the offset space).
//
// Style/harness idiom copied from e2e/phase5a-e2e.js: check()/FAIL-style
// assertions, one script, exit 1 on any failure. Unlike phase5a, this script
// never touches the browser or the signaling server directly — the darkroom
// CLI (scripts/darkroom/index.mjs) is the thing under test, and IT is what
// launches real ffmpeg and real headless Chrome (via
// scripts/darkroom/composite.mjs's renderBackdrop, the same playwright-core
// EXECUTABLE-resolution pattern phase5a uses) as a side effect of
// developing an episode with video.
//
// Run: `node e2e/darkroom-e2e.js` (no dev server / signaling server needed —
// the darkroom is a standalone CLI over a vault directory).
//
// DEVIATION FROM THE BRIEF'S LITERAL CHECK 4 TEXT (confirmed empirically,
// not a bug introduced or fixed here — see task-7-report.md for the full
// account with numbers):
//
// The brief's check 4 says to decode the polished `episode.m4a` and
// `findMarks` on it directly. Measured directly: `arnndn` (RNNoise, part of
// the pinned Studio-parity chain every stem goes through — chain.mjs's
// `chainFilter`, frozen since Task 4) attenuates a frame containing ONLY the
// synthetic dual-tone mark (no concurrent "voice" content, which is exactly
// what the mark's own 420ms window looks like, mark or no mark) by roughly
// two orders of magnitude — the tone's Goertzel-band-to-floor ratio drops
// from ~15x pre-enhancement to ~0.3-0.7x post-`arnndn`, far under
// `findMarks`'s (correct, spec-mandated) 6x candidate-frame gate, REGARDLESS
// of the mark's amplitude or how "voice-like" the surrounding noise bed is
// tuned to be (both tried — see the report). This isn't a fixture-tunable
// problem: a listener does not want an audible sync beep surviving into
// their finished podcast either, so the pipeline was never designed for the
// mark to survive mastering, and `developEpisode` itself only ever calls
// `findMarks` on the RAW (pre-enhancement) audio — never on the mix.
//
// What this check verifies instead (NARROWLY — see the "what this does NOT
// verify" note below, added in review round 2): it builds a small
// VERIFICATION mix directly from the developed episode's own
// `raw/local-audio.webm` + `raw/remote-audio.webm` (the exact bytes
// `developEpisode` reassembled from the vault's parts) using
// `remoteAudioFilter(ratio)` and the `adelay` derived from `delayMs`/`who`
// — read straight out of the just-written `develop.json`, and the SAME
// `drift.mjs` function the pipeline itself calls, imported live, not
// reimplemented — then mixes with a plain real-ffmpeg `amix` (no denoise/
// loudnorm — deliberately isolating drift correction from mastering) and
// runs the real `findMarks` (scripts/darkroom/tone.mjs) on the result. A
// genuinely-corrected alignment must land this verification mix's start AND
// end marks within +/-1ms of local's own (unmodified, untouched-by-any-
// filter) raw mark positions — the fixture's committed ground truth.
//
// What this does NOT verify (IMPORTANT 2, Task 7 review round 2): this
// check's own `localDelayMs = develop.who === "local" ? develop.delayMs : 0`
// line mirrors the SAME side-mapping expression pipeline.mjs itself uses
// (pipeline.mjs:177-178) to decide which side's `adelay` gets `delayMs`. A
// bug that swapped `who` (e.g. `alignment()` itself returning the wrong
// side) would swap identically here and the two mixes would still land on
// the same wrong-but-matching answer — this check alone cannot catch a
// side-swap. That is caught separately: check 3 now asserts `develop.who`/
// `develop.delayMs` against `truth.json`'s `expectedWho`/`expectedDelayMs`
// (computed independently, from the fixture's generation parameters, never
// from this or any other pipeline output), and the check 4b duration
// assertion below cross-checks the ARCHIVAL `episode.m4a`'s real measured
// duration against an expectation built from the fixture's own raw/
// durations + `develop.ratio`/`delayMs`/`who` — a side-swap would also
// throw that off, independently of this verification-mix machinery.
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const DARKROOM_CLI = path.join(REPO_ROOT, "scripts/darkroom/index.mjs");
const FIXTURES_ROOT = path.join(REPO_ROOT, "scripts/darkroom/fixtures");
const MODEL_PATH = path.join(REPO_ROOT, "server/models/std.rnnn");
const OWN_CODENAME = "CARDINAL";

const SAMPLE_RATE = 48000;
const ONE_MS_SAMPLES = SAMPLE_RATE / 1000; // 48
const M4A_DURATION_TOLERANCE_S = 0.15; // aac encoder priming/padding + loudnorm-linear rounding

const FIXTURES = [
  { dirName: "episode-fix01", takeId: "take-20260101-0000-fee1" },
  { dirName: "episode-fix02", takeId: "take-20260101-0001-fee2" },
];

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) failures++;
  return ok;
};

// ---------------------------------------------------------------------
// small process/fs helpers
// ---------------------------------------------------------------------

function runCapture(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runDarkroomOnce(args) {
  return runCapture(process.execPath, [DARKROOM_CLI, ...args], { cwd: REPO_ROOT });
}

/** Spawns the darkroom watcher as a long-running child. Caller owns killing it. */
function spawnWatcher(vaultDir) {
  return spawn(
    process.execPath,
    [DARKROOM_CLI, "--vault", vaultDir, "--own-codename", OWN_CODENAME, "--poll-ms", "500"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** SIGTERM, then SIGKILL after a grace period if it hasn't exited — used on
 *  every exit path (success, check failure, or thrown error) so a stray
 *  watcher child is never left running past this script's own lifetime. */
function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function waitForFile(filePath, timeoutMs, pollMs = 250) {
  const startedAt = Date.now();
  for (;;) {
    if (fs.existsSync(filePath)) return Date.now() - startedAt;
    if (Date.now() - startedAt >= timeoutMs) return -1;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function copyDir(src, dest) {
  await fsp.cp(src, dest, { recursive: true });
}

async function hashTree(rootDir) {
  const out = {};
  async function walk(dir, relPrefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // "episodes/" is the darkroom's OWN output, never a source dir — a
        // sibling of the take dir, not something we'd ever be asked to hash
        // here since we always hash the take dir itself, but skip defensively.
        if (entry.name === "episodes") continue;
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const buf = await fsp.readFile(abs);
        out[rel] = crypto.createHash("sha256").update(buf).digest("hex");
      }
    }
  }
  await walk(rootDir, "");
  return out;
}

function hashTreesEqual(before, after) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.length !== afterKeys.length) return false;
  for (let i = 0; i < beforeKeys.length; i++) {
    if (beforeKeys[i] !== afterKeys[i]) return false;
  }
  return beforeKeys.every((k) => before[k] === after[k]);
}

async function ffprobeJson(file) {
  const { code, stdout, stderr } = await runCapture("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed on ${file}: ${stderr}`);
  return JSON.parse(stdout);
}

async function ffprobeDuration(file) {
  const probe = await ffprobeJson(file);
  return Number(probe.format.duration);
}

// ---------------------------------------------------------------------
// check 4's verification-mix builder (see header deviation note)
// ---------------------------------------------------------------------

async function verifyRawAlignment(rawDir, develop, truth, darkroom) {
  const localRaw = path.join(rawDir, "local-audio.webm");
  const remoteRaw = path.join(rawDir, "remote-audio.webm");
  // Minor (Task 7 review round 2): this is scratch, not an episode product
  // — it lives in its own OS-temp dir (never under episodes/<id>/, and
  // never reusing pipeline.mjs's own work/ scratch dir, which is deleted by
  // the pipeline itself before the watcher ever reports done), cleaned up
  // unconditionally before this function returns.
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-e2e-verifymix-"));
  const outMix = path.join(scratchDir, "verify-mix.wav");

  try {
    const localDelayMs = develop.who === "local" ? develop.delayMs : 0;
    const remoteDelayMs = develop.who === "remote" ? develop.delayMs : 0;
    const remoteDrift = darkroom.remoteAudioFilter(develop.ratio); // the pipeline's OWN filter, live-imported

    const filterComplex =
      `[0:a]adelay=${Math.round(localDelayMs)}:all=1[da];` +
      `[1:a]${remoteDrift},adelay=${Math.round(remoteDelayMs)}:all=1[db];` +
      `[da][db]amix=inputs=2:normalize=0[outa]`;

    const { code, stderr } = await runCapture("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      localRaw,
      "-i",
      remoteRaw,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outa]",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_f32le",
      outMix,
    ]);
    if (code !== 0) throw new Error(`verify-mix ffmpeg failed: ${stderr}`);

    const runner = darkroom.makeRunner("ffmpeg");
    const pcm = await darkroom.decodePcm(runner, outMix);
    const { start, end } = darkroom.findMarks(pcm);

    // Expected fused position: whichever side is EARLIER gets delayed to
    // meet the other, so the fused mark lands at local's OWN position
    // shifted by local's own delay (0 when who==="remote", since local
    // stays put and remote is the one that moves to meet it). Bug fixed in
    // review round 2: this used to compare against local's raw truth
    // position unconditionally, which is only correct for who==="remote" —
    // for who==="local" local itself is the side that moves, so the fused
    // mark lands ~delayMs later than local's raw position, not AT it
    // (caught immediately: fixture 2 failed this check by exactly
    // delayMs's worth of samples before this fix).
    const localDelaySamples = (localDelayMs / 1000) * SAMPLE_RATE;
    const expectedStart = truth.local.startSample + localDelaySamples;
    const expectedEnd = truth.local.endSample + localDelaySamples;

    const startDeltaSamples = Math.abs(start - expectedStart);
    const endDeltaSamples = Math.abs(end - expectedEnd);
    return { start, end, expectedStart, expectedEnd, startDeltaSamples, endDeltaSamples };
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// one fixture's full flow: checks 1-6 + 8 (watcher hands-off develop,
// products, ground truth, alignment, ffprobe, sources untouched, rerun).
// ---------------------------------------------------------------------

async function runFixtureFlow(fixture, darkroom, tmpDirs, watchers) {
  const label = fixture.dirName;
  const fixtureTakeDir = path.join(FIXTURES_ROOT, fixture.dirName, fixture.takeId);
  const truthPath = path.join(FIXTURES_ROOT, fixture.dirName, "truth.json");
  const truth = JSON.parse(await fsp.readFile(truthPath, "utf8"));

  const vault = await fsp.mkdtemp(path.join(os.tmpdir(), `darkroom-e2e-${fixture.dirName}-`));
  tmpDirs.push(vault);
  const takeDir = path.join(vault, fixture.takeId);
  await copyDir(fixtureTakeDir, takeDir);

  const hashBefore = await hashTree(takeDir);

  // ---- Check 1: the WATCHER (never --develop) fires from the manifest
  // alone, within 15s. ----
  // Pushed into the SHARED `watchers` array (owned by main()'s finally
  // block) immediately on spawn, before any `await` that could throw —
  // otherwise a check failure/error partway through this function would
  // leak the child, since a thrown/rejected runFixtureFlow never reaches
  // its own return statement for the caller to collect the handle from.
  const watcher = spawnWatcher(vault);
  watchers.push(watcher);
  let watcherStderr = "";
  watcher.stderr.on("data", (d) => (watcherStderr += d));
  const episodesDir = path.join(vault, "episodes", fixture.takeId);
  const developJsonPath = path.join(episodesDir, "develop.json");
  const elapsedMs = await waitForFile(developJsonPath, 15000);
  check(elapsedMs >= 0, `[${label}] watcher develops the fixture hands-off within 15s (took ${elapsedMs}ms)`);
  if (elapsedMs < 0) {
    console.error(`[${label}] watcher stderr so far:\n` + watcherStderr);
  }

  // ---- Check 2: episodes/<id>/ contains the expected product set. ----
  const m4aPath = path.join(episodesDir, "episode.m4a");
  const mp4Path = path.join(episodesDir, "episode.mp4");
  const stemsDir = path.join(episodesDir, "stems");
  const rawDir = path.join(episodesDir, "raw");
  const stemsEntries = fs.existsSync(stemsDir) ? await fsp.readdir(stemsDir) : [];
  const rawEntries = fs.existsSync(rawDir) ? await fsp.readdir(rawDir) : [];
  check(fs.existsSync(m4aPath), `[${label}] episode.m4a exists`);
  check(fs.existsSync(mp4Path), `[${label}] episode.mp4 exists (both hosts had video)`);
  check(stemsEntries.length === 2, `[${label}] stems/ has 2 entries (got ${stemsEntries.length}: ${stemsEntries.join(", ")})`);
  check(rawEntries.length === 4, `[${label}] raw/ has 4 entries (got ${rawEntries.length}: ${rawEntries.join(", ")})`);
  check(fs.existsSync(developJsonPath), `[${label}] develop.json exists`);

  // ---- Check 3: develop.json vs the fixture's committed ground truth. ----
  const develop = JSON.parse(await fsp.readFile(developJsonPath, "utf8"));
  const ratioPpmOff = Math.abs(develop.ratio - truth.ratioTarget) * 1e6;
  check(
    ratioPpmOff <= 5,
    `[${label}] develop.json.ratio ${develop.ratio} within +/-5ppm of ${truth.ratioTarget} (off by ${ratioPpmOff.toFixed(3)}ppm)`,
  );
  const markChecks = [
    ["local.start", develop.marks.local.start, truth.local.startSample],
    ["local.end", develop.marks.local.end, truth.local.endSample],
    ["remote.start", develop.marks.remote.start, truth.remote.startSample],
    ["remote.end", develop.marks.remote.end, truth.remote.endSample],
  ];
  for (const [markLabel, got, want] of markChecks) {
    check(Math.abs(got - want) <= 1, `[${label}] develop.json marks.${markLabel} = ${got}, within +/-1 sample of ground truth ${want}`);
  }
  // IMPORTANT 2 (Task 7 review round 2): assert the delay-to-SIDE mapping
  // itself against truth.json's independently-computed expectedWho/
  // expectedDelayMs — this is the one place that actually pins `who`
  // against ground truth rather than trusting develop.json's own say-so
  // (which is what check 4's verification mix, by construction, cannot do
  // — see the file header's "what this does NOT verify" note).
  check(develop.who === truth.expectedWho, `[${label}] develop.json.who = "${develop.who}" matches ground truth "${truth.expectedWho}"`);
  const delayDeltaMs = Math.abs(develop.delayMs - truth.expectedDelayMs);
  check(
    delayDeltaMs <= 0.05,
    `[${label}] develop.json.delayMs ${develop.delayMs} within 0.05ms of ground truth ${truth.expectedDelayMs} (delta ${delayDeltaMs.toFixed(4)}ms)`,
  );

  // ---- Check 4: alignment END-TO-END (raw-audio verification mix; see the
  // file header's deviation note for what this does and does not verify). ----
  const alignment = await verifyRawAlignment(rawDir, develop, truth, darkroom);
  check(
    alignment.startDeltaSamples <= ONE_MS_SAMPLES,
    `[${label}] start marks fuse to within 1ms in the corrected raw mix (found sample ${alignment.start}, expected ${alignment.expectedStart.toFixed(1)} [local truth ${truth.local.startSample} + local delay], delta ${alignment.startDeltaSamples.toFixed(3)} samples = ${(alignment.startDeltaSamples / ONE_MS_SAMPLES).toFixed(3)}ms)`,
  );
  check(
    alignment.endDeltaSamples <= ONE_MS_SAMPLES,
    `[${label}] end marks fuse to within 1ms in the corrected raw mix (found sample ${alignment.end}, expected ${alignment.expectedEnd.toFixed(1)} [local truth ${truth.local.endSample} + local delay], delta ${alignment.endDeltaSamples.toFixed(3)} samples = ${(alignment.endDeltaSamples / ONE_MS_SAMPLES).toFixed(3)}ms)`,
  );

  // ---- Check 4b (IMPORTANT 2b): the ARCHIVAL episode.m4a's real measured
  // duration vs. an expectation built from the fixture's own raw/ audio
  // durations + develop.json's ratio/delayMs/who. episode.m4a carries no
  // duration cap (mixApplyArgs's amix defaults to duration=longest, and
  // unlike the mp4 there's no output -shortest on this product — D21), so
  // its true duration is exactly max(local's delayed length, remote's
  // rate-corrected + delayed length) modulo encoder priming. A side-swap
  // bug (who computed backwards) would apply the delay to the wrong side
  // and throw this off independently of check 4's verification mix. ----
  const localAudioDurationS = await ffprobeDuration(path.join(rawDir, "local-audio.webm"));
  const remoteAudioDurationS = await ffprobeDuration(path.join(rawDir, "remote-audio.webm"));
  const localDelayS = develop.who === "local" ? develop.delayMs / 1000 : 0;
  const remoteDelayS = develop.who === "remote" ? develop.delayMs / 1000 : 0;
  const expectedM4aDuration = Math.max(localAudioDurationS + localDelayS, remoteAudioDurationS * develop.ratio + remoteDelayS);
  const actualM4aDuration = await ffprobeDuration(m4aPath);
  const m4aDurationDelta = Math.abs(actualM4aDuration - expectedM4aDuration);
  check(
    m4aDurationDelta <= M4A_DURATION_TOLERANCE_S,
    `[${label}] episode.m4a duration ${actualM4aDuration.toFixed(3)}s matches max(local+delay, corrected remote+delay) = ${expectedM4aDuration.toFixed(3)}s (delta ${m4aDurationDelta.toFixed(3)}s, tolerance ${M4A_DURATION_TOLERANCE_S}s)`,
  );

  // ---- Check 5: ffprobe products. ----
  const m4aProbe = await ffprobeJson(m4aPath);
  const m4aAudio = (m4aProbe.streams || []).find((s) => s.codec_type === "audio");
  check(!!m4aAudio && m4aAudio.codec_name === "aac", `[${label}] episode.m4a audio codec is aac (got ${m4aAudio && m4aAudio.codec_name})`);
  check(
    !!m4aAudio && String(m4aAudio.sample_rate) === "48000",
    `[${label}] episode.m4a sample rate is 48000 (got ${m4aAudio && m4aAudio.sample_rate})`,
  );

  const mp4Probe = await ffprobeJson(mp4Path);
  const mp4Video = (mp4Probe.streams || []).find((s) => s.codec_type === "video");
  const mp4Audio = (mp4Probe.streams || []).find((s) => s.codec_type === "audio");
  check(!!mp4Video && mp4Video.codec_name === "h264", `[${label}] episode.mp4 video codec is h264 (got ${mp4Video && mp4Video.codec_name})`);
  check(
    !!mp4Video && mp4Video.width === 1920 && mp4Video.height === 1080,
    `[${label}] episode.mp4 is 1920x1080 (got ${mp4Video && mp4Video.width}x${mp4Video && mp4Video.height})`,
  );
  check(!!mp4Audio && mp4Audio.codec_name === "aac", `[${label}] episode.mp4 audio codec is aac (got ${mp4Audio && mp4Audio.codec_name})`);

  // Minor (Task 7 review round 2): the duration reference gains the LOCAL
  // delay term — needed now that episode-fix02 exercises who==="local",
  // where local's own chain (raw + its own tpad delay) is what the mp4's
  // video is actually pinned to, not local's raw length alone.
  const localVideoDurationS = await ffprobeDuration(path.join(rawDir, "local-video.webm"));
  const localReferenceDuration = localVideoDurationS + localDelayS;
  const mp4Duration = Number(mp4Probe.format.duration);
  const durationDeltaS = Math.abs(mp4Duration - localReferenceDuration);
  check(
    durationDeltaS <= 0.2,
    `[${label}] episode.mp4 duration ${mp4Duration.toFixed(3)}s within 0.2s of local reference ${localReferenceDuration.toFixed(3)}s = raw ${localVideoDurationS.toFixed(3)}s + delay ${localDelayS.toFixed(3)}s (delta ${durationDeltaS.toFixed(3)}s)`,
  );

  // ---- Check 6: sources untouched — byte-hash the fixture copy before/
  // after developing; must be identical. ----
  const hashAfter = await hashTree(takeDir);
  check(hashTreesEqual(hashBefore, hashAfter), `[${label}] source take dir is byte-identical before/after developing (sources untouched)`);

  // Stop the watcher before driving a manual --develop rerun on the same
  // vault (check 8) — avoids a background poll racing the rerun. Left in
  // the shared `watchers` array; killChild is idempotent on an already-
  // exited child, so main()'s finally re-killing it is a safe no-op.
  await killChild(watcher);

  // ---- Check 8: --develop reruns a developed episode and exits 0,
  // replacing products. ----
  const completedAtBefore = develop.completedAt;
  const manifestPath = path.join(takeDir, "episode.json");
  const rerun = await runDarkroomOnce([
    "--develop",
    manifestPath,
    "--vault",
    vault,
    "--own-codename",
    OWN_CODENAME,
    "--model",
    MODEL_PATH,
  ]);
  check(rerun.code === 0, `[${label}] --develop rerun on an already-developed episode exits 0 (got ${rerun.code}; stderr: ${rerun.stderr.trim()})`);
  const developAfterRerun = JSON.parse(await fsp.readFile(developJsonPath, "utf8"));
  check(
    developAfterRerun.completedAt !== completedAtBefore,
    `[${label}] rerun actually replaced develop.json (completedAt changed: ${completedAtBefore} -> ${developAfterRerun.completedAt})`,
  );
  check(fs.existsSync(m4aPath) && fs.existsSync(mp4Path), `[${label}] rerun replaced episode.m4a and episode.mp4 (both still present)`);
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

(async () => {
  // Dynamic import: this script is CommonJS (matching phase5a-e2e.js's own
  // style), but the darkroom modules under test are plain ESM .mjs — a CJS
  // script loading ESM via dynamic import() is the standard, supported
  // bridge, and it's the ONLY way check 4 can call the pipeline's REAL
  // drift.mjs/tone.mjs/decode.mjs/runner.mjs functions directly rather than
  // reimplementing them (which would test a copy of the logic, not the
  // logic).
  const darkroom = {
    ...(await import("../scripts/darkroom/drift.mjs")),
    ...(await import("../scripts/darkroom/tone.mjs")),
    ...(await import("../scripts/darkroom/decode.mjs")),
    ...(await import("../scripts/darkroom/runner.mjs")),
  };

  const watchers = [];
  const tmpDirs = [];

  try {
    // =================================================================
    // Checks 1-6 + 8, run once per fixture (both offset directions).
    // =================================================================
    for (const fixture of FIXTURES) {
      await runFixtureFlow(fixture, darkroom, tmpDirs, watchers);
    }

    // =================================================================
    // Vault B: check 7 — gap refusal (fixture 1 is sufficient; the refusal
    // path doesn't depend on which offset direction the fixture encodes).
    // =================================================================
    const vaultB = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-e2e-gap-"));
    tmpDirs.push(vaultB);
    const gapFixture = FIXTURES[0];
    const fixtureTakeDirB = path.join(FIXTURES_ROOT, gapFixture.dirName, gapFixture.takeId);
    const takeDirB = path.join(vaultB, gapFixture.takeId);
    await copyDir(fixtureTakeDirB, takeDirB);
    await fsp.rm(path.join(takeDirB, "remote", "audio.part001"));
    // vault.mjs's verifyEpisode checks existence of every MANIFEST-listed
    // part BEFORE checking for index gaps (see darkroom-vault.test.ts's own
    // "note: part file EXISTS in the list but missing on disk ->
    // part-missing; list itself skipping an index -> part-gap. Cover
    // BOTH."). Deleting only the file, with the manifest still listing it,
    // is therefore a part-missing case, not part-gap — the brief's literal
    // "delete remote/audio.part001 -> ... part-gap" undershoots what it
    // takes to reach that specific code. To exercise the GAP path (the
    // check's stated intent), the manifest's own entry list has to skip an
    // index too: remove audio.part001's entry from remote.audio, leaving
    // 000 and 002 — a genuine gap in the numbered sequence, independent of
    // what's on disk.
    const manifestPathB = path.join(takeDirB, "episode.json");
    const manifestB = JSON.parse(await fsp.readFile(manifestPathB, "utf8"));
    manifestB.remote.audio = manifestB.remote.audio.filter((e) => e.name !== "audio.part001");
    await fsp.writeFile(manifestPathB, JSON.stringify(manifestB, null, 2));
    const gapRun = await runDarkroomOnce([
      "--develop",
      manifestPathB,
      "--vault",
      vaultB,
      "--own-codename",
      OWN_CODENAME,
      "--model",
      MODEL_PATH,
    ]);
    check(gapRun.code !== 0, `gap refusal: --develop exits non-zero (got ${gapRun.code})`);
    check(gapRun.stderr.includes("part-gap"), `gap refusal: stderr names part-gap (got: ${gapRun.stderr.trim()})`);
    const episodesDirB = path.join(vaultB, "episodes", gapFixture.takeId);
    check(!fs.existsSync(path.join(episodesDirB, "episode.mp4")), "gap refusal: episodes/<id>/episode.mp4 was never created");
    // Minor (Task 7 review round 2): also assert the REAL D22 developed
    // marker (develop.json) is absent — episode.mp4 not existing only rules
    // out video products; an audio-only episode never has an mp4 at all, so
    // develop.json absence is the actual "this episode was never developed"
    // signal the watcher itself keys on.
    check(!fs.existsSync(path.join(episodesDirB, "develop.json")), "gap refusal: episodes/<id>/develop.json (the real developed marker) was never created");
  } finally {
    for (const watcher of watchers) {
      await killChild(watcher);
    }
    for (const dir of tmpDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("SCRIPT ERROR:", err);
  process.exit(1);
});
