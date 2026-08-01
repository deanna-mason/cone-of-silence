// e2e/darkroom-e2e.js
// Phase 5C acceptance: the darkroom's committed fixture episode develops
// HANDS-OFF via the vault WATCHER (never --develop) against real ffmpeg and
// a real headless-Chrome backdrop render, with sample-accurate alignment
// verified against the fixture's own committed ground truth
// (scripts/darkroom/fixtures/episode-fix01/truth.json), sources left
// byte-identical, a gap refusal, and a re-runnable --develop.
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
// What this check verifies instead, preserving check 4's actual intent
// ("drift actually corrected, not just measured", using the pipeline's own
// real numbers and real ffmpeg filters, not an independent recomputation):
// it builds a small VERIFICATION mix directly from the developed episode's
// own `raw/local-audio.webm` + `raw/remote-audio.webm` (the exact bytes
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
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const DARKROOM_CLI = path.join(REPO_ROOT, "scripts/darkroom/index.mjs");
const FIXTURE_TAKE_DIR = path.join(REPO_ROOT, "scripts/darkroom/fixtures/episode-fix01/take-20260101-0000-fee1");
const TRUTH_PATH = path.join(REPO_ROOT, "scripts/darkroom/fixtures/episode-fix01/truth.json");
const TAKE_ID = "take-20260101-0000-fee1";
const MODEL_PATH = path.join(REPO_ROOT, "server/models/std.rnnn");
const OWN_CODENAME = "CARDINAL";
const REMOTE_CODENAME = "NIGHTINGALE"; // manifest's receivedFrom, committed in the fixture

const SAMPLE_RATE = 48000;
const ONE_MS_SAMPLES = SAMPLE_RATE / 1000; // 48

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

// ---------------------------------------------------------------------
// check 4's verification-mix builder (see header deviation note)
// ---------------------------------------------------------------------

async function verifyRawAlignment(episodesDir, develop, truth, darkroom) {
  const rawDir = path.join(episodesDir, "raw");
  const localRaw = path.join(rawDir, "local-audio.webm");
  const remoteRaw = path.join(rawDir, "remote-audio.webm");
  const outMix = path.join(episodesDir, "verify-mix.wav");

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

  const startDeltaSamples = Math.abs(start - truth.local.startSample);
  const endDeltaSamples = Math.abs(end - truth.local.endSample);
  return { start, end, startDeltaSamples, endDeltaSamples };
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

(async () => {
  const truth = JSON.parse(await fsp.readFile(TRUTH_PATH, "utf8"));

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

  let watcherA = null;
  const tmpDirs = [];

  try {
    // =================================================================
    // Vault A: checks 1-6 (watcher, hands-off develop) + check 8 (rerun)
    // =================================================================
    const vaultA = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-e2e-a-"));
    tmpDirs.push(vaultA);
    const takeDirA = path.join(vaultA, TAKE_ID);
    await copyDir(FIXTURE_TAKE_DIR, takeDirA);

    const hashBefore = await hashTree(takeDirA);

    // ---- Check 1: the WATCHER (never --develop) fires from the manifest
    // alone, within 15s. ----
    watcherA = spawnWatcher(vaultA);
    let watcherStderr = "";
    watcherA.stderr.on("data", (d) => (watcherStderr += d));
    const episodesDirA = path.join(vaultA, "episodes", TAKE_ID);
    const developJsonPath = path.join(episodesDirA, "develop.json");
    const elapsedMs = await waitForFile(developJsonPath, 15000);
    check(elapsedMs >= 0, `watcher develops the fixture hands-off within 15s (took ${elapsedMs}ms)`);
    if (elapsedMs < 0) {
      console.error("watcher stderr so far:\n" + watcherStderr);
    }

    // ---- Check 2: episodes/<id>/ contains the expected product set. ----
    const m4aPath = path.join(episodesDirA, "episode.m4a");
    const mp4Path = path.join(episodesDirA, "episode.mp4");
    const stemsDir = path.join(episodesDirA, "stems");
    const rawDir = path.join(episodesDirA, "raw");
    const stemsEntries = fs.existsSync(stemsDir) ? await fsp.readdir(stemsDir) : [];
    const rawEntries = fs.existsSync(rawDir) ? await fsp.readdir(rawDir) : [];
    check(fs.existsSync(m4aPath), "episode.m4a exists");
    check(fs.existsSync(mp4Path), "episode.mp4 exists (both hosts had video)");
    check(stemsEntries.length === 2, `stems/ has 2 entries (got ${stemsEntries.length}: ${stemsEntries.join(", ")})`);
    check(rawEntries.length === 4, `raw/ has 4 entries (got ${rawEntries.length}: ${rawEntries.join(", ")})`);
    check(fs.existsSync(developJsonPath), "develop.json exists");

    // ---- Check 3: develop.json vs the fixture's committed ground truth. ----
    const develop = JSON.parse(await fsp.readFile(developJsonPath, "utf8"));
    const ratioPpmOff = Math.abs(develop.ratio - truth.ratioTarget) * 1e6;
    check(ratioPpmOff <= 5, `develop.json.ratio ${develop.ratio} within +/-5ppm of ${truth.ratioTarget} (off by ${ratioPpmOff.toFixed(3)}ppm)`);
    const markChecks = [
      ["local.start", develop.marks.local.start, truth.local.startSample],
      ["local.end", develop.marks.local.end, truth.local.endSample],
      ["remote.start", develop.marks.remote.start, truth.remote.startSample],
      ["remote.end", develop.marks.remote.end, truth.remote.endSample],
    ];
    for (const [label, got, want] of markChecks) {
      check(Math.abs(got - want) <= 1, `develop.json marks.${label} = ${got}, within +/-1 sample of ground truth ${want}`);
    }

    // ---- Check 4: alignment END-TO-END — see the file header's deviation
    // note for why this verifies via a raw-audio verification mix (built
    // with the pipeline's own real drift.mjs filters + develop.json's own
    // ratio/delayMs/who) rather than findMarks on the polished episode.m4a,
    // which arnndn (part of the pinned Studio-parity chain) empirically
    // strips the synthetic tone out of regardless of fixture tuning. ----
    const alignment = await verifyRawAlignment(episodesDirA, develop, truth, darkroom);
    check(
      alignment.startDeltaSamples <= ONE_MS_SAMPLES,
      `start marks fuse to within 1ms in the corrected raw mix (found sample ${alignment.start}, local truth ${truth.local.startSample}, delta ${alignment.startDeltaSamples} samples = ${(alignment.startDeltaSamples / ONE_MS_SAMPLES).toFixed(3)}ms)`,
    );
    check(
      alignment.endDeltaSamples <= ONE_MS_SAMPLES,
      `end marks fuse to within 1ms in the corrected raw mix (found sample ${alignment.end}, local truth ${truth.local.endSample}, delta ${alignment.endDeltaSamples} samples = ${(alignment.endDeltaSamples / ONE_MS_SAMPLES).toFixed(3)}ms)`,
    );

    // ---- Check 5: ffprobe products. ----
    const m4aProbe = await ffprobeJson(m4aPath);
    const m4aAudio = (m4aProbe.streams || []).find((s) => s.codec_type === "audio");
    check(!!m4aAudio && m4aAudio.codec_name === "aac", `episode.m4a audio codec is aac (got ${m4aAudio && m4aAudio.codec_name})`);
    check(!!m4aAudio && String(m4aAudio.sample_rate) === "48000", `episode.m4a sample rate is 48000 (got ${m4aAudio && m4aAudio.sample_rate})`);

    const mp4Probe = await ffprobeJson(mp4Path);
    const mp4Video = (mp4Probe.streams || []).find((s) => s.codec_type === "video");
    const mp4Audio = (mp4Probe.streams || []).find((s) => s.codec_type === "audio");
    check(!!mp4Video && mp4Video.codec_name === "h264", `episode.mp4 video codec is h264 (got ${mp4Video && mp4Video.codec_name})`);
    check(!!mp4Video && mp4Video.width === 1920 && mp4Video.height === 1080, `episode.mp4 is 1920x1080 (got ${mp4Video && mp4Video.width}x${mp4Video && mp4Video.height})`);
    check(!!mp4Audio && mp4Audio.codec_name === "aac", `episode.mp4 audio codec is aac (got ${mp4Audio && mp4Audio.codec_name})`);

    const localVideoProbe = await ffprobeJson(path.join(rawDir, "local-video.webm"));
    const localReferenceDuration = Number(localVideoProbe.format.duration);
    const mp4Duration = Number(mp4Probe.format.duration);
    const durationDeltaS = Math.abs(mp4Duration - localReferenceDuration);
    check(
      durationDeltaS <= 0.2,
      `episode.mp4 duration ${mp4Duration.toFixed(3)}s within 0.2s of local reference ${localReferenceDuration.toFixed(3)}s (delta ${durationDeltaS.toFixed(3)}s)`,
    );

    // ---- Check 6: sources untouched — byte-hash the fixture copy before/
    // after developing; must be identical. ----
    const hashAfter = await hashTree(takeDirA);
    check(hashTreesEqual(hashBefore, hashAfter), "vault A source take dir is byte-identical before/after developing (sources untouched)");

    // Stop the watcher before driving a manual --develop rerun on the same
    // vault (check 8) — avoids a background poll racing the rerun.
    await killChild(watcherA);
    watcherA = null;

    // ---- Check 8: --develop reruns a developed episode and exits 0,
    // replacing products. ----
    const completedAtBefore = develop.completedAt;
    const manifestPathA = path.join(takeDirA, "episode.json");
    const rerun = await runDarkroomOnce([
      "--develop",
      manifestPathA,
      "--vault",
      vaultA,
      "--own-codename",
      OWN_CODENAME,
      "--model",
      MODEL_PATH,
    ]);
    check(rerun.code === 0, `--develop rerun on an already-developed episode exits 0 (got ${rerun.code}; stderr: ${rerun.stderr.trim()})`);
    const developAfterRerun = JSON.parse(await fsp.readFile(developJsonPath, "utf8"));
    check(
      developAfterRerun.completedAt !== completedAtBefore,
      `rerun actually replaced develop.json (completedAt changed: ${completedAtBefore} -> ${developAfterRerun.completedAt})`,
    );
    check(fs.existsSync(m4aPath) && fs.existsSync(mp4Path), "rerun replaced episode.m4a and episode.mp4 (both still present)");

    // =================================================================
    // Vault B: check 7 — gap refusal.
    // =================================================================
    const vaultB = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-e2e-b-"));
    tmpDirs.push(vaultB);
    const takeDirB = path.join(vaultB, TAKE_ID);
    await copyDir(FIXTURE_TAKE_DIR, takeDirB);
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
    const mp4PathB = path.join(vaultB, "episodes", TAKE_ID, "episode.mp4");
    check(!fs.existsSync(mp4PathB), "gap refusal: episodes/<id>/episode.mp4 was never created");
  } finally {
    await killChild(watcherA);
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
