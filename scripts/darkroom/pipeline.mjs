// The one orchestration: verify -> reassemble -> tone-align -> drift-correct
// -> enhance -> episode.m4a (+ composited episode.mp4 when both hosts have
// video) -> develop.json receipt. Every side-effecting dependency (ffmpeg
// runner, headless-Chrome backdrop render, PCM decode, clock) arrives in one
// injected `deps` object, so this module and its tests never spawn a real
// process or launch a real browser themselves — index.mjs wires the real
// ones; unit tests drive the whole pipeline with fakes.
//
// Sources are sacred: nothing here ever writes into a take dir or its
// `remote/` subdir. All writes land under `<vault>/episodes/<episodeId>/`
// (D11). Both `episode.mp4` (when video is present) and `develop.json` get
// the temp-then-rename "developed marker" discipline — each is written to
// `work/` and renamed into place LAST, so a crash mid-pipeline never leaves
// a false-positive marker for the watcher. D22 (Task 6 review round) moved
// the actual marker the watcher checks from `episode.mp4` to `develop.json`
// — an audio-only episode never produces an mp4 at all, so mp4-presence
// can't be the universal "done" signal; `develop.json` is written for every
// successful develop, video or not, and is renamed into place strictly
// after the mp4 rename (when there is one).
import fsp from "node:fs/promises";
import path from "node:path";

import { DarkroomError } from "./errors.mjs";
import { readEpisode, verifyEpisode } from "./vault.mjs";
import { reassemble, remuxArgs } from "./concat.mjs";
import { findMarks } from "./tone.mjs";
import { driftRatio, remoteAudioFilter, remoteVideoSetpts, alignment } from "./drift.mjs";
import { measureStem, applyStemArgs, mixMeasureArgs, mixApplyArgs } from "./chain.mjs";
import { compositeArgs } from "./composite.mjs";

export const DEFAULT_OWN_CODENAME = "HOST";
export const DEFAULT_MODEL = "server/models/std.rnnn";

function findStream(streams, host, base) {
  return streams.find((s) => s.host === host && s.base === base) || null;
}

/** Extracts and validates the last `{...}` block in ffmpeg's stderr — same
 *  shape as chain.mjs's private loudnorm-JSON parser (that one is scoped to
 *  a single stem's measure pass; this one drives the two-input mix's own
 *  measure pass, which chain.mjs only builds argv for, it doesn't run or
 *  parse it). Kept as a small local copy rather than reaching into chain.mjs
 *  internals — it isn't part of the pinned parity surface. */
function parseMixLoudnorm(stderr) {
  const matches = stderr.match(/\{[^{}]*\}/g);
  if (!matches || matches.length === 0) {
    throw new DarkroomError("ffmpeg-failed", "mix loudnorm measurement json not found in ffmpeg output");
  }
  let parsed;
  try {
    parsed = JSON.parse(matches[matches.length - 1]);
  } catch {
    throw new DarkroomError("ffmpeg-failed", "mix loudnorm measurement json in ffmpeg output is not valid JSON");
  }
  const pick = (key) => {
    const v = parsed[key];
    if (typeof v !== "string") {
      throw new DarkroomError("ffmpeg-failed", `mix loudnorm measurement json missing "${key}"`);
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

function parseFfmpegVersion(stdout) {
  const firstLine = stdout.toString("utf8").split("\n")[0] || "";
  const match = firstLine.match(/ffmpeg version (\S+)/);
  return match ? match[1] : "unknown";
}

/**
 * developEpisode(deps, manifestPath, opts) -> Promise<Receipt>
 *
 * deps = { runner, renderBackdrop, decodePcm, now } — every side effect.
 * opts = { ownCodename, model, chromePath, templatePath }.
 *
 * Throws DarkroomError on any refusal (manifest-invalid, part-missing,
 * part-gap, size-mismatch, hash-mismatch, tone-*-missing, tone-one-beep,
 * ffmpeg-failed, template-render-failed). A refusal always leaves the take
 * dir untouched; verification refusals (part-gap, hash-mismatch, etc.) fire
 * before any workspace directory is created or any ffmpeg call is made.
 */
export async function developEpisode(deps, manifestPath, opts = {}) {
  const {
    ownCodename = DEFAULT_OWN_CODENAME,
    model = DEFAULT_MODEL,
    chromePath,
    templatePath,
  } = opts;

  const takeDir = path.dirname(manifestPath);
  const vaultDir = path.dirname(takeDir);
  const takeIdFromDir = path.basename(takeDir);

  // Step 1: readEpisode + verifyEpisode. Refusals here propagate untouched —
  // nothing has been written yet, and the runner has never been invoked.
  const episode = await readEpisode(takeDir);

  // D22 (Task 6 review): pin the takeId/episodeId coincidence the rest of
  // this pipeline (and the watcher's marker path) relies on. Without this,
  // a manifest whose episodeId doesn't match its own take dir would develop
  // successfully but write its outputs under episodes/<episodeId>/ while
  // the watcher keeps checking episodes/<takeId>/ for the marker — an
  // infinite, silent re-develop of the same take under what looks to the
  // watcher like a brand-new episode every single poll.
  if (episode.manifest.episodeId !== takeIdFromDir) {
    throw new DarkroomError(
      "manifest-invalid",
      `episodeId "${episode.manifest.episodeId}" does not match take dir "${takeIdFromDir}"`,
    );
  }

  await verifyEpisode(episode);

  const localAudio = findStream(episode.streams, "local", "audio");
  const remoteAudio = findStream(episode.streams, "remote", "audio");
  if (!localAudio || !remoteAudio) {
    throw new DarkroomError("manifest-invalid", "episode needs both hosts' audio to align");
  }
  const localVideo = findStream(episode.streams, "local", "video");
  const remoteVideo = findStream(episode.streams, "remote", "video");
  const hasVideo = Boolean(localVideo && remoteVideo);

  const episodeId = episode.manifest.episodeId;
  const episodesRoot = path.join(vaultDir, "episodes", episodeId);
  const rawDir = path.join(episodesRoot, "raw");
  const stemsDir = path.join(episodesRoot, "stems");
  const workDir = path.join(episodesRoot, "work");
  await fsp.mkdir(rawDir, { recursive: true });
  await fsp.mkdir(stemsDir, { recursive: true });
  await fsp.mkdir(workDir, { recursive: true });

  // IMPORTANT 4 (Task 6 review): work/ is scratch space only — every path
  // below that survives a develop (raw/, stems/, episode.m4a, episode.mp4,
  // develop.json) is written OUTSIDE workDir before this returns or throws.
  // The `finally` guarantees work/ (concat temporaries, backdrop.png, and a
  // half-written develop.json/episode.mp4 on a mid-pipeline failure) never
  // lingers, on success OR failure.
  try {
    const { stdout: versionOut } = await deps.runner.capture(["-version"]);
    const ffmpegVersion = parseFfmpegVersion(versionOut);

    // Step 2: reassemble + remux every stream the manifest actually lists.
    const rawPaths = {};
    for (const stream of episode.streams) {
      const key = `${stream.host}-${stream.base}`;
      const concatPath = path.join(workDir, `${key}.concat`);
      const finalPath = path.join(rawDir, `${key}.webm`);
      await reassemble(stream.entries, stream.dir, concatPath);
      await deps.runner.run(remuxArgs(concatPath, finalPath));
      await fsp.rm(concatPath, { force: true });
      rawPaths[key] = finalPath;
    }

    // Step 3: decode both audio raws, find marks, compute drift + alignment.
    const localPcm = await deps.decodePcm(deps.runner, rawPaths["local-audio"]);
    const remotePcm = await deps.decodePcm(deps.runner, rawPaths["remote-audio"]);
    const localMarks = findMarks(localPcm);
    const remoteMarks = findMarks(remotePcm);

    const ratio = driftRatio(localMarks, remoteMarks);
    // D23 (review CRITICAL 2): the remote start mark's sample index,
    // converted into the corrected (rate-scaled) timeline that
    // remoteAudioFilter(ratio) actually produces. remoteAudioFilter uses
    // asetrate=SAMPLE_RATE/ratio, which maps an original sample index n to
    // n*ratio in the corrected stream (see drift.mjs's own doc comment for
    // the full derivation) — MULTIPLY, not divide, so alignment() compares
    // like-for-like against the (also *ratio-scaled) video timeline.
    const remoteStartCorrected = remoteMarks.start * ratio;
    const { delayMs, who } = alignment(localMarks.start, remoteStartCorrected);
    const localDelayMs = who === "local" ? delayMs : 0;
    const remoteDelayMs = who === "remote" ? delayMs : 0;

    // Step 4: per-host Studio-parity stems. Remote's drift filter is
    // prepended to its chain (both for measurement and for the apply pass).
    const remoteDrift = remoteAudioFilter(ratio);
    const remoteStemName = episode.manifest.receivedFrom ?? "remote";
    const localStemOut = path.join(stemsDir, `${ownCodename}.m4a`);
    const remoteStemOut = path.join(stemsDir, `${remoteStemName}.m4a`);

    const localMeasurement = await measureStem(deps.runner, rawPaths["local-audio"], model);
    await deps.runner.run(applyStemArgs(rawPaths["local-audio"], model, localMeasurement, localStemOut));

    const remoteMeasurement = await measureStem(deps.runner, rawPaths["remote-audio"], model, remoteDrift);
    await deps.runner.run(
      applyStemArgs(rawPaths["remote-audio"], model, remoteMeasurement, remoteStemOut, remoteDrift),
    );

    // Step 5: mix the two enhanced stems (alignment delays) -> episode.m4a.
    const localDelayFilter = `adelay=${Math.round(localDelayMs)}:all=1`;
    const remoteDelayFilter = `adelay=${Math.round(remoteDelayMs)}:all=1`;
    const episodeM4a = path.join(episodesRoot, "episode.m4a");

    const { stderr: mixStderr } = await deps.runner.run(
      mixMeasureArgs(localStemOut, remoteStemOut, localDelayFilter, remoteDelayFilter),
    );
    const mixMeasurement = parseMixLoudnorm(mixStderr);
    await deps.runner.run(
      mixApplyArgs(localStemOut, remoteStemOut, localDelayFilter, remoteDelayFilter, mixMeasurement, episodeM4a),
    );

    // Step 6: backdrop render + composite -> work/episode.mp4 -> rename
    // LAST. Only attempted when BOTH hosts have video (mirrors the audio
    // rule) — an audio-only episode (or a one-sided video episode) has
    // nothing to composite a side-by-side frame from.
    let mp4Written = false;
    if (hasVideo) {
      const remoteLabel = episode.manifest.receivedFrom ?? "PARTNER";
      const backdropPng = path.join(workDir, "backdrop.png");
      const layout = await deps.renderBackdrop(
        chromePath,
        templatePath,
        { left: ownCodename, right: remoteLabel },
        backdropPng,
      );

      const workMp4 = path.join(workDir, "episode.mp4");
      const argv = compositeArgs(
        backdropPng,
        rawPaths["local-video"],
        rawPaths["remote-video"],
        layout,
        {
          remoteSetpts: remoteVideoSetpts(ratio),
          delays: { local: localDelayMs, remote: remoteDelayMs },
        },
        episodeM4a,
        workMp4,
      );
      await deps.runner.run(argv);

      const finalMp4 = path.join(episodesRoot, "episode.mp4");
      await fsp.rename(workMp4, finalMp4);
      mp4Written = true;
    }

    // Step 7: develop.json receipt. D22 (review IMPORTANT 3): this — not
    // episode.mp4 — is now the developed marker the watcher checks, since
    // an audio-only episode never produces an mp4 at all. Same temp+rename
    // discipline as the mp4 (and for the same reason): a truncated
    // plain-write receipt would still read as "developed" and permanently
    // skip a half-developed take. Written after the mp4 rename above, as
    // the LAST act of a successful develop.
    const receipt = {
      episodeId,
      completedAt: deps.now(),
      marks: {
        local: { start: localMarks.start, end: localMarks.end },
        remote: { start: remoteMarks.start, end: remoteMarks.end },
      },
      ratio,
      delayMs,
      who,
      products: mp4Written ? ["m4a", "mp4"] : ["m4a"],
      toolVersions: { node: process.version, ffmpeg: ffmpegVersion },
    };
    const workReceipt = path.join(workDir, "develop.json");
    const finalReceipt = path.join(episodesRoot, "develop.json");
    await fsp.writeFile(workReceipt, JSON.stringify(receipt, null, 2));
    await fsp.rename(workReceipt, finalReceipt);

    return receipt;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}
