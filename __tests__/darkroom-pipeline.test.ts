// @vitest-environment node
//
// Task 5: composite arg-builder cases only (cover-scale+crop, remote-only
// setpts ordering, audio/encoding invariants). renderBackdrop launches real
// headless Chrome and is exercised by the e2e (e2e/darkroom-e2e.js, Task 7)
// and by the one-off local hand-check render — not unit-tested here.
//
// Task 6 extends this same file with developEpisode/CLI orchestration cases.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { compositeArgs } from "../scripts/darkroom/composite.mjs";
import { DarkroomError } from "../scripts/darkroom/errors.mjs";
import { SAMPLE_RATE, synthesizeMark, findMarks } from "../scripts/darkroom/tone.mjs";
import { driftRatio, alignment } from "../scripts/darkroom/drift.mjs";
import { developEpisode } from "../scripts/darkroom/pipeline.mjs";
import {
  pollOnce,
  isDeveloped,
  developedMarkerPath,
  parseArgs,
  resolveChromePath,
  makeRefusalBackoff,
} from "../scripts/darkroom/index.mjs";
import { scanVault } from "../scripts/darkroom/vault.mjs";

const LAYOUT = {
  left: { x: 86, y: 180, w: 820, h: 615 },
  right: { x: 1014, y: 180, w: 800, h: 600 }, // deliberately different from left, to prove per-pane geometry isn't hardcoded
};

function inputIndexOf(args: string[], file: string): number {
  const flagIdx = args.indexOf(file);
  expect(args[flagIdx - 1]).toBe("-i");
  // Count how many "-i" flags precede this one to get the ffmpeg input index.
  let idx = -1;
  for (let i = 0; i <= flagIdx; i++) {
    if (args[i] === "-i") idx++;
  }
  return idx;
}

function filterComplexOf(args: string[]): string {
  const i = args.indexOf("-filter_complex");
  expect(i).toBeGreaterThan(-1);
  return args[i + 1];
}

/** Pulls the filtergraph segment for a given labeled input (e.g. "[1:v]") —
 *  everything up to the next "[label]" sink, so ordering/content assertions
 *  can be scoped to just the local or just the remote chain. */
function segmentFor(filterComplex: string, inputLabel: string): string {
  const nodes = filterComplex.split(";");
  const node = nodes.find((n) => n.startsWith(inputLabel));
  expect(node, `expected a filtergraph node starting with ${inputLabel} in: ${filterComplex}`).toBeTruthy();
  return node as string;
}

describe("composite.mjs — compositeArgs", () => {
  it("cover-scale+crop into both pane rects, overlay coords from layout", () => {
    const args = compositeArgs(
      "/tmp/backdrop.png",
      "/tmp/local.webm",
      "/tmp/remote.webm",
      LAYOUT,
      { remoteSetpts: "setpts=PTS*1.000200000", delays: { local: 0, remote: 0 } },
      "/tmp/episode.m4a",
      "/tmp/out.mp4",
    );
    const fc = filterComplexOf(args);

    // object-fit: cover == scale-to-cover (increase) + center crop, per pane's
    // OWN w/h (design 2026-08-03: full-frame tiles; raw stays uncropped).
    expect(fc).toContain("scale=820:615:force_original_aspect_ratio=increase");
    expect(fc).toContain("crop=820:615");
    expect(fc).toContain("scale=800:600:force_original_aspect_ratio=increase");
    expect(fc).toContain("crop=800:600");
    expect(fc).not.toContain("force_original_aspect_ratio=decrease");
    expect(fc).not.toContain("pad=820");
    expect(fc).not.toContain("pad=800");

    // Overlay placement comes straight from the layout, not baked constants.
    expect(fc).toContain("overlay=86:180");
    expect(fc).toContain("overlay=1014:180");
  });

  it("remote chain applies setpts before pad/overlay; local never setpts", () => {
    const args = compositeArgs(
      "/tmp/backdrop.png",
      "/tmp/local.webm",
      "/tmp/remote.webm",
      LAYOUT,
      { remoteSetpts: "setpts=PTS*0.999800000", delays: { local: 0, remote: 10 } },
      "/tmp/episode.m4a",
      "/tmp/out.mp4",
    );
    const fc = filterComplexOf(args);
    const localIdx = inputIndexOf(args, "/tmp/local.webm");
    const remoteIdx = inputIndexOf(args, "/tmp/remote.webm");

    const localSeg = segmentFor(fc, `[${localIdx}:v]`);
    const remoteSeg = segmentFor(fc, `[${remoteIdx}:v]`);

    // Local is the reference timeline — it is never rate-corrected.
    expect(localSeg).not.toContain("setpts");

    // Remote gets setpts, THEN its delay (tpad), both strictly before the
    // cover scale/crop that feeds the overlay.
    expect(remoteSeg).toContain("setpts=PTS*0.999800000");
    const setptsPos = remoteSeg.indexOf("setpts=PTS*0.999800000");
    const tpadPos = remoteSeg.indexOf("tpad=");
    const scalePos = remoteSeg.indexOf("scale=");
    const cropPos = remoteSeg.indexOf("crop=800:600");
    expect(tpadPos).toBeGreaterThan(-1);
    expect(setptsPos).toBeLessThan(tpadPos);
    expect(tpadPos).toBeLessThan(scalePos);
    expect(scalePos).toBeLessThan(cropPos);
  });

  it("local carries its own delay (tpad) when it is the earlier side — still never setpts", () => {
    const args = compositeArgs(
      "/tmp/backdrop.png",
      "/tmp/local.webm",
      "/tmp/remote.webm",
      LAYOUT,
      { remoteSetpts: "setpts=PTS*1.000200000", delays: { local: 25, remote: 0 } },
      "/tmp/episode.m4a",
      "/tmp/out.mp4",
    );
    const fc = filterComplexOf(args);
    const localIdx = inputIndexOf(args, "/tmp/local.webm");
    const localSeg = segmentFor(fc, `[${localIdx}:v]`);

    expect(localSeg).not.toContain("setpts");
    expect(localSeg).toContain("tpad=start_duration=0.025");
    expect(localSeg.indexOf("tpad=")).toBeLessThan(localSeg.indexOf("scale="));
  });

  it("audio mapped from m4a, faststart, yuv420p — and duration is EXACTLY pinned to LOCAL (D21: apad + output -shortest)", () => {
    const args = compositeArgs(
      "/tmp/backdrop.png",
      "/tmp/local.webm",
      "/tmp/remote.webm",
      LAYOUT,
      { remoteSetpts: "setpts=PTS*1.000200000", delays: { local: 0, remote: 0 } },
      "/tmp/episode.m4a",
      "/tmp/out.mp4",
    );
    const audioIdx = inputIndexOf(args, "/tmp/episode.m4a");

    // D21 (controller ruling, review of this task): the LOCAL overlay's
    // per-filter `shortest=1` (below) only pins the VIDEO stream — the
    // audio (mixApplyArgs's amix defaults to duration=longest upstream)
    // can still outlast local on churn/reconnect asymmetries, which would
    // make the finished mp4's real container duration exceed local. Fixed
    // by routing the audio through `apad` (infinite pad) and adding the
    // output-level `-shortest` flag: the container then ends exactly when
    // the video (already local-capped) ends. This supersedes the plan's
    // literal "-shortest NOT used" line — that line's INTENT (don't let a
    // short remote truncate the video) is preserved by the video-side
    // `overlay=...:shortest=1` cap; `-shortest` here is the audio-side
    // exact-pin idiom, not a reversion to naive shortest-of-everything.
    // `apad` requires filtering, so this output's audio is re-encoded
    // (aac 192k) rather than copied — `-c:a copy` is no longer asserted.
    // The archival episode.m4a itself is untouched; only the composite
    // mp4's muxed-in audio track is re-encoded.
    expect(args).toEqual(
      expect.arrayContaining([
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
      ]),
    );
    expect(args).not.toContain("copy");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");

    // apad sits in the audio's own filtergraph node, fed by the m4a input.
    const fc = filterComplexOf(args);
    expect(fc).toContain(`[${audioIdx}:a]apad`);

    // -shortest is an OUTPUT option: it must come after every -map (the
    // filtergraph's audio AND video sinks are both mapped by then) and
    // before the output path.
    const shortestIdx = args.indexOf("-shortest");
    const lastMapIdx = args.lastIndexOf("-map");
    expect(shortestIdx).toBeGreaterThan(lastMapIdx);
    expect(shortestIdx).toBeLessThan(args.length - 1);

    // Duration-pin mechanism (video side), ROUND 2 (Task 7 review): exactly
    // ONE `:shortest=1`, and it must sit on the LAST overlay stage (the one
    // whose secondary input is `lpad`, local's own chain) — not the first.
    //
    // Round 1 (shipped, then reverted — see composite.mjs's doc comment for
    // the full derivation) put local FIRST with its own `shortest=1`
    // (making bg1 finite, exactly local's length) and added a SECOND
    // `shortest=1` on remote's stage. That computes min(bg1, rpad) =
    // min(localLen, remoteLen) — pins to whichever side is SHORTER, not to
    // local specifically. It happened to look right against the bug report
    // that motivated it (remote longer than local) and silently pinned to
    // REMOTE instead the moment local was the longer side (`who ===
    // "local"`, content loss + truncated audio via the output `-shortest`
    // below) — reviewer-measured 150fr/5.000s against a 180fr/6.000s local
    // reference. The corrected graph puts remote FIRST with no shortest
    // (bg1 stays effectively infinite, driven by the looped backdrop input,
    // regardless of remote's length) and local LAST carrying the ONLY
    // shortest=1 — order-independent, verified 180fr/6.000s with either
    // side longer (e2e now runs both directions: episode-fix01 is
    // `who: "remote"`, episode-fix02 is `who: "local"`).
    expect((fc.match(/:shortest=1/g) || []).length).toBe(1);
    const lastOverlaySeg = fc.split(";").find((seg) => seg.includes("overlay=") && seg.includes(":shortest=1"));
    expect(lastOverlaySeg).toBeDefined();
    expect(lastOverlaySeg).toContain("[lpad]");
    expect(lastOverlaySeg).toContain("[outv]");
  });

  it("first overlay stage (remote onto the backdrop) carries NO shortest — bg1 must stay effectively infinite regardless of remote's length (Task 7 review round 2)", () => {
    const args = compositeArgs(
      "/tmp/backdrop.png",
      "/tmp/local.webm",
      "/tmp/remote.webm",
      LAYOUT,
      { remoteSetpts: "setpts=PTS*1.000200000", delays: { local: 250, remote: 0 } },
      "/tmp/episode.m4a",
      "/tmp/out.mp4",
    );
    const fc = filterComplexOf(args);
    const firstOverlaySeg = fc.split(";").find((seg) => seg.includes("[0:v][rpad]overlay="));
    expect(firstOverlaySeg).toBeDefined();
    expect(firstOverlaySeg).not.toContain("shortest");
    expect(firstOverlaySeg).toContain("[bg1]");

    // And the second/last stage overlays LOCAL onto bg1, carrying the sole
    // shortest=1 — this is the who==="local" direction (local delayed,
    // so LOCAL is the longer chain here): the graph shape must not change
    // based on which side happens to be longer.
    const secondOverlaySeg = fc.split(";").find((seg) => seg.includes("[bg1][lpad]overlay="));
    expect(secondOverlaySeg).toBeDefined();
    expect(secondOverlaySeg).toContain(":shortest=1");
  });
});

// ---------------------------------------------------------------------------
// Task 6: developEpisode orchestration + index.mjs CLI/watcher.
//
// ALL side effects arrive via one injected deps object ({runner,
// renderBackdrop, decodePcm, now}) so the whole pipeline is driven with
// fakes — no real ffmpeg, no real Chrome. `findMarks`/`driftRatio`/
// `alignment` are the REAL functions (pure DSP, already pinned by Tasks 2-3's
// own test files) run against synthetic PCM built with the real
// `synthesizeMark()`, so expectations below are computed from the SAME
// detector the pipeline itself calls — this is deliberately not a
// magic-number pin against the brief's illustrative "1.0002" readout (see
// darkroom-drift.test.ts's own note on why that number isn't the literal
// ratio).
describe("pipeline.mjs — developEpisode", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-pipeline-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  interface SidecarEntry {
    name: string;
    size: number;
    sha256: string;
  }

  async function writePart(dir: string, name: string, bytes: Buffer): Promise<SidecarEntry> {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), bytes);
    return { name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }

  function manifestFor(opts: {
    episodeId: string;
    receivedFrom?: string | null;
    local?: { audio: SidecarEntry[]; video: SidecarEntry[] } | null;
    remote?: { audio: SidecarEntry[]; video: SidecarEntry[] };
  }) {
    return {
      version: 1,
      episodeId: opts.episodeId,
      receivedFrom: opts.receivedFrom ?? null,
      completedAt: "2026-01-01T00:00:00.000Z",
      local: opts.local === undefined ? null : opts.local,
      remote: opts.remote ?? { audio: [], video: [] },
    };
  }

  async function writeManifest(takeDir: string, manifest: unknown): Promise<void> {
    await fsp.writeFile(path.join(takeDir, "episode.json"), JSON.stringify(manifest, null, 2));
  }

  /** A real, hash-valid two-host take dir (one part per stream — content is
   *  arbitrary bytes; verifyEpisode only checks size/hash, never decodes
   *  media). `video: false` omits both hosts' video streams entirely
   *  (audio-only case). */
  async function buildValidTake(
    takeId: string,
    opts: { video: boolean; receivedFrom?: string | null },
  ): Promise<{ takeDir: string; manifestPath: string }> {
    const takeDir = path.join(tmpRoot, takeId);
    const remoteDir = path.join(takeDir, "remote");

    const localAudio = await writePart(takeDir, "audio.part000", Buffer.from("local-audio-bytes"));
    const remoteAudio = await writePart(remoteDir, "audio.part000", Buffer.from("remote-audio-bytes"));
    const local: { audio: SidecarEntry[]; video: SidecarEntry[] } = { audio: [localAudio], video: [] };
    const remote: { audio: SidecarEntry[]; video: SidecarEntry[] } = { audio: [remoteAudio], video: [] };

    if (opts.video) {
      local.video = [await writePart(takeDir, "video.part000", Buffer.from("local-video-bytes"))];
      remote.video = [await writePart(remoteDir, "video.part000", Buffer.from("remote-video-bytes"))];
    }

    const manifest = manifestFor({ episodeId: takeId, receivedFrom: opts.receivedFrom ?? "NIGHTINGALE", local, remote });
    await writeManifest(takeDir, manifest);
    return { takeDir, manifestPath: path.join(takeDir, "episode.json") };
  }

  /** `lengthS` seconds of silence with the real dual-tone mark summed in at
   *  each of `marks` (seconds from track start) — noise-free by design, so
   *  the matched-filter's cross-correlation resolves to the exact injected
   *  sample (see darkroom-tone.test.ts's own noise-free regression cases for
   *  the same pattern), keeping this test's math independent of any
   *  detector jitter. */
  function buildAudioTrack(lengthS: number, marks: number[]): Float32Array {
    const pcm = new Float32Array(Math.round(lengthS * SAMPLE_RATE));
    const mark = synthesizeMark();
    for (const markS of marks) {
      const at = Math.round(markS * SAMPLE_RATE);
      for (let i = 0; i < mark.length && at + i < pcm.length; i++) pcm[at + i] += mark[i];
    }
    return pcm;
  }

  const CANNED_LOUDNORM_JSON = `{
    "input_i" : "-20.00",
    "input_tp" : "-3.00",
    "input_lra" : "6.00",
    "input_thresh" : "-30.00",
    "output_i" : "-16.00",
    "output_tp" : "-1.50",
    "output_lra" : "5.00",
    "output_thresh" : "-26.00",
    "normalization_type" : "dynamic",
    "target_offset" : "0.00"
}`;

  function cannedLoudnormStderr(): string {
    return ["[Parsed_loudnorm_0]", CANNED_LOUDNORM_JSON, "frame=1 fps=1 speed=8.0x"].join("\n");
  }

  type FakeRunnerHooks = { onRun?: (args: string[]) => void };

  /** Records every run()/capture() call (one shared, time-ordered list —
   *  the "argv sequence" the brief asks for), fakes ffmpeg's -version probe,
   *  and — since nothing spawns real ffmpeg — writes a stub file at
   *  whatever path an argv's last element names (mirroring the file ffmpeg
   *  would have produced), so downstream fs.rename / existence checks have
   *  something real to observe. */
  function makeFakeRunner(hooks: FakeRunnerHooks = {}) {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args: string[]) => {
        calls.push(args);
        hooks.onRun?.(args);
        const last = args[args.length - 1];
        if (typeof last === "string" && last !== "-" && !last.startsWith("-")) {
          fs.mkdirSync(path.dirname(last), { recursive: true });
          fs.writeFileSync(last, "stub");
        }
        return { stderr: cannedLoudnormStderr() };
      },
      capture: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "-version") {
          return { stdout: Buffer.from("ffmpeg version 8.1.2-static Copyright (c) 2000-2026\n"), stderr: "" };
        }
        throw new Error(`fake runner: unexpected capture() call: ${JSON.stringify(args)}`);
      },
    };
  }

  // Fakes hand back the {full} short-take shape — findMarksWindowed
  // delegates it to findMarks, so these tests keep pinning the exact
  // whole-track mark math they always did.
  function makeFakeDecodeMarkWindows(localPcm: Float32Array, remotePcm: Float32Array) {
    return async (_runner: unknown, file: string, _windowSamples: number): Promise<{ full: Float32Array }> => {
      if (file.includes("local-audio")) return { full: localPcm };
      if (file.includes("remote-audio")) return { full: remotePcm };
      throw new Error(`fake decodeMarkWindows: unexpected file ${file}`);
    };
  }

  function makeFakeRenderBackdrop() {
    const calls: Array<{ left: string; right: string; outPng: string }> = [];
    const layout = {
      left: { x: 86, y: 180, w: 820, h: 615 },
      right: { x: 1014, y: 180, w: 800, h: 600 },
    };
    return {
      calls,
      layout,
      renderBackdrop: async (
        _chromePath: unknown,
        _templatePath: unknown,
        labels: { left: string; right: string },
        outPng: string,
      ) => {
        calls.push({ left: labels.left, right: labels.right, outPng });
        fs.writeFileSync(outPng, "stubpng");
        return layout;
      },
    };
  }

  const NEVER_CALLED = async () => {
    throw new Error("should not have been called on a refusal path");
  };

  it("develops a fake episode end-to-end: argv sequence, products, receipt fields", async () => {
    // The matched-filter search (findMarks, real — see the describe-block
    // header) over a 10s/9s track is the slow part here; generous under
    // parallel test-file load, still fast in isolation (~3s).
    const takeId = "take-20260101-0000-fee1";
    const { manifestPath } = await buildValidTake(takeId, { video: true, receivedFrom: "NIGHTINGALE" });

    const localPcm = buildAudioTrack(10, [1.0, 7.0]); // span 6.000s
    const remotePcm = buildAudioTrack(9, [1.0, 6.9988]); // span 5.9988s

    // Ground truth computed from the SAME real detector/math the pipeline
    // calls — see the describe-block header for why this beats a literal
    // "1.0002" pin.
    const expectedLocalMarks = findMarks(localPcm);
    const expectedRemoteMarks = findMarks(remotePcm);
    const expectedRatio = driftRatio(expectedLocalMarks, expectedRemoteMarks);
    // D23: MULTIPLY by ratio, matching remoteAudioFilter's corrected
    // timeline (see drift.mjs's doc comment / pipeline.mjs's own comment at
    // this same computation).
    const expectedRemoteStartCorrected = expectedRemoteMarks.start * expectedRatio;
    const expectedAlignment = alignment(expectedLocalMarks.start, expectedRemoteStartCorrected);

    const { renderBackdrop, calls: backdropCalls } = makeFakeRenderBackdrop();
    const episodesRoot = path.join(tmpRoot, "episodes", takeId);
    const workMp4 = path.join(episodesRoot, "work", "episode.mp4");
    const finalMp4 = path.join(episodesRoot, "episode.mp4");
    let mp4ExistedBeforeComposite: boolean | null = null;
    const runnerWithHook = makeFakeRunner({
      onRun: (args) => {
        if (args[args.length - 1] === workMp4) {
          mp4ExistedBeforeComposite = fs.existsSync(finalMp4);
        }
      },
    });

    const deps = {
      runner: runnerWithHook,
      renderBackdrop,
      decodeMarkWindows: makeFakeDecodeMarkWindows(localPcm, remotePcm),
      now: () => "2026-08-01T00:00:00.000Z",
    };
    const opts = {
      ownCodename: "CARDINAL",
      model: "server/models/std.rnnn",
      chromePath: "/fake/chrome",
      templatePath: "/fake/template.html",
    };

    const receipt = await developEpisode(deps, manifestPath, opts);

    // --- receipt fields -----------------------------------------------
    expect(receipt.episodeId).toBe(takeId);
    expect(receipt.completedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(receipt.marks).toEqual({
      local: { start: expectedLocalMarks.start, end: expectedLocalMarks.end },
      remote: { start: expectedRemoteMarks.start, end: expectedRemoteMarks.end },
    });
    expect(receipt.ratio).toBeCloseTo(expectedRatio, 9);
    expect(receipt.delayMs).toBe(expectedAlignment.delayMs);
    expect(receipt.who).toBe(expectedAlignment.who);
    expect(receipt.products).toEqual(["m4a", "mp4"]);
    expect(receipt.toolVersions).toEqual({ node: process.version, ffmpeg: "8.1.2-static" });

    // --- labels (D14: local LEFT as --own-codename, remote RIGHT as receivedFrom) ---
    expect(backdropCalls).toEqual([{ left: "CARDINAL", right: "NIGHTINGALE", outPng: expect.any(String) }]);

    // --- products on disk ----------------------------------------------
    expect(fs.existsSync(path.join(episodesRoot, "episode.m4a"))).toBe(true);
    expect(fs.existsSync(finalMp4)).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "stems", "CARDINAL.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "stems", "NIGHTINGALE.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "raw", "local-audio.webm"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "raw", "local-video.webm"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "raw", "remote-audio.webm"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "raw", "remote-video.webm"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "develop.json"))).toBe(true);
    const onDisk = JSON.parse(await fsp.readFile(path.join(episodesRoot, "develop.json"), "utf8"));
    expect(onDisk).toEqual(receipt);

    // --- rename-LAST discipline (D11): work/episode.mp4 must NOT exist yet
    // at the moment the composite ffmpeg call fires (it's created by that
    // very call and only renamed into place afterward); by the time
    // developEpisode resolves it must be gone from work/ (renamed, not
    // copied).
    expect(mp4ExistedBeforeComposite).toBe(false);
    expect(fs.existsSync(workMp4)).toBe(false);

    // --- IMPORTANT 4: work/ (concat temps, backdrop.png) is gone entirely
    // on success, not just the mp4 that got renamed out of it.
    expect(fs.existsSync(path.join(episodesRoot, "work"))).toBe(false);

    // --- argv sequence ---------------------------------------------------
    const calls = runnerWithHook.calls;
    const rawDir = path.join(episodesRoot, "raw");
    const stemsDir = path.join(episodesRoot, "stems");
    const lastArg = (call: string[]) => call[call.length - 1];

    expect(calls.length).toBe(12);
    expect(calls[0]).toEqual(["-version"]);
    expect(lastArg(calls[1])).toBe(path.join(rawDir, "local-audio.webm"));
    expect(lastArg(calls[2])).toBe(path.join(rawDir, "local-video.webm"));
    expect(lastArg(calls[3])).toBe(path.join(rawDir, "remote-audio.webm"));
    expect(lastArg(calls[4])).toBe(path.join(rawDir, "remote-video.webm"));
    expect(lastArg(calls[5])).toBe("-"); // measureStem(local)
    expect(lastArg(calls[6])).toBe(path.join(stemsDir, "CARDINAL.m4a")); // applyStemArgs(local)
    expect(lastArg(calls[7])).toBe("-"); // measureStem(remote)
    expect(lastArg(calls[8])).toBe(path.join(stemsDir, "NIGHTINGALE.m4a")); // applyStemArgs(remote)
    expect(lastArg(calls[9])).toBe("-"); // mixMeasureArgs
    expect(lastArg(calls[10])).toBe(path.join(episodesRoot, "episode.m4a")); // mixApplyArgs
    expect(lastArg(calls[11])).toBe(workMp4); // compositeArgs

    // Remote's chain carried the drift filter; local's did not.
    expect(calls[7][calls[7].indexOf("-af") + 1]).toMatch(/^asetrate=/);
    expect(calls[5][calls[5].indexOf("-af") + 1]).not.toMatch(/^asetrate=/);
  }, 20000);

  it("gap in remote parts → part-gap refusal, episodes/<id>/ has NO episode.mp4 and raw/ empty or absent", async () => {
    const takeId = "take-20260101-0000-9a91";
    const takeDir = path.join(tmpRoot, takeId);
    const remoteDir = path.join(takeDir, "remote");

    const localAudio = await writePart(takeDir, "audio.part000", Buffer.from("local-audio"));
    const remotePart000 = await writePart(remoteDir, "audio.part000", Buffer.from("remote-a"));
    const remotePart002 = await writePart(remoteDir, "audio.part002", Buffer.from("remote-c")); // 001 never listed

    await writeManifest(
      takeDir,
      manifestFor({
        episodeId: takeId,
        local: { audio: [localAudio], video: [] },
        remote: { audio: [remotePart000, remotePart002], video: [] },
      }),
    );

    const fakeRunner = makeFakeRunner();
    const deps = {
      runner: fakeRunner,
      renderBackdrop: NEVER_CALLED,
      decodeMarkWindows: NEVER_CALLED,
      now: () => "2026-01-01T00:00:00.000Z",
    };

    await expect(
      developEpisode(deps, path.join(takeDir, "episode.json"), { ownCodename: "CARDINAL" }),
    ).rejects.toMatchObject({ code: "part-gap" });

    expect(fakeRunner.calls.length).toBe(0);
    const episodesRoot = path.join(tmpRoot, "episodes", takeId);
    expect(fs.existsSync(path.join(episodesRoot, "episode.mp4"))).toBe(false);
    const rawDir = path.join(episodesRoot, "raw");
    const rawEntries = fs.existsSync(rawDir) ? await fsp.readdir(rawDir) : [];
    expect(rawEntries).toEqual([]);
  });

  it("hash mismatch → refusal BEFORE any ffmpeg call (runner never invoked)", async () => {
    const takeId = "take-20260101-0000-9a92";
    const { takeDir, manifestPath } = await buildValidTake(takeId, { video: false });
    const filePath = path.join(takeDir, "audio.part000");
    const bytes = await fsp.readFile(filePath);
    bytes[0] ^= 0xff;
    await fsp.writeFile(filePath, bytes);

    const fakeRunner = makeFakeRunner();
    const deps = {
      runner: fakeRunner,
      renderBackdrop: NEVER_CALLED,
      decodeMarkWindows: NEVER_CALLED,
      now: () => "2026-01-01T00:00:00.000Z",
    };

    await expect(developEpisode(deps, manifestPath, { ownCodename: "CARDINAL" })).rejects.toMatchObject({
      code: "hash-mismatch",
    });
    expect(fakeRunner.calls.length).toBe(0);
  });

  it("audio-only both sides (video lists [] on both) → episode.m4a + stems, NO mp4, receipt says products:[m4a]", async () => {
    const takeId = "take-20260101-0000-a0d1";
    const { manifestPath } = await buildValidTake(takeId, { video: false, receivedFrom: "NIGHTINGALE" });

    const localPcm = buildAudioTrack(8, [1.0, 6.5]);
    const remotePcm = buildAudioTrack(8, [1.0, 6.4988]);

    const fakeRunner = makeFakeRunner();
    const { renderBackdrop, calls: backdropCalls } = makeFakeRenderBackdrop();
    const deps = {
      runner: fakeRunner,
      renderBackdrop,
      decodeMarkWindows: makeFakeDecodeMarkWindows(localPcm, remotePcm),
      now: () => "2026-01-01T00:00:00.000Z",
    };

    const receipt = await developEpisode(deps, manifestPath, { ownCodename: "CARDINAL" });

    expect(receipt.products).toEqual(["m4a"]);
    expect(backdropCalls.length).toBe(0);

    const episodesRoot = path.join(tmpRoot, "episodes", takeId);
    expect(fs.existsSync(path.join(episodesRoot, "episode.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "episode.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(episodesRoot, "work"))).toBe(false); // IMPORTANT 4: gone on success too
    expect(fs.existsSync(path.join(episodesRoot, "stems", "CARDINAL.m4a"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "stems", "NIGHTINGALE.m4a"))).toBe(true);
    expect(fakeRunner.calls.some((c) => c.includes("-loop"))).toBe(false); // no compositeArgs call
  }, 20000);

  it("local null → manifest-invalid refusal (needs both hosts' audio)", async () => {
    const takeId = "take-20260101-0000-0e11";
    const takeDir = path.join(tmpRoot, takeId);
    const remoteDir = path.join(takeDir, "remote");
    const remoteAudio = await writePart(remoteDir, "audio.part000", Buffer.from("remote-audio"));

    await writeManifest(
      takeDir,
      manifestFor({ episodeId: takeId, local: null, remote: { audio: [remoteAudio], video: [] } }),
    );

    const fakeRunner = makeFakeRunner();
    const deps = {
      runner: fakeRunner,
      renderBackdrop: NEVER_CALLED,
      decodeMarkWindows: NEVER_CALLED,
      now: () => "2026-01-01T00:00:00.000Z",
    };

    await expect(
      developEpisode(deps, path.join(takeDir, "episode.json"), { ownCodename: "CARDINAL" }),
    ).rejects.toMatchObject({ code: "manifest-invalid" });

    expect(fakeRunner.calls.length).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, "episodes", takeId))).toBe(false);
  });

  it("D22: manifest.episodeId not matching its own take dir name → manifest-invalid refusal (kills the infinite-re-develop-under-a-new-costume risk)", async () => {
    const takeId = "take-20260101-0000-1234";
    const { manifestPath } = await buildValidTake(takeId, { video: false });

    // Overwrite the manifest so episodeId disagrees with the dir it lives
    // in. Without this refusal, developEpisode would happily write products
    // under episodes/<wrong-id>/ while the watcher keeps checking
    // episodes/<takeId>/ for the marker — an infinite re-develop loop.
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    manifest.episodeId = "take-20260101-0000-9999";
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));

    const fakeRunner = makeFakeRunner();
    const deps = {
      runner: fakeRunner,
      renderBackdrop: NEVER_CALLED,
      decodeMarkWindows: NEVER_CALLED,
      now: () => "2026-01-01T00:00:00.000Z",
    };

    await expect(developEpisode(deps, manifestPath, { ownCodename: "CARDINAL" })).rejects.toMatchObject({
      code: "manifest-invalid",
    });

    expect(fakeRunner.calls.length).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, "episodes", "take-20260101-0000-9999"))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, "episodes", takeId))).toBe(false);
  });

  it("IMPORTANT 4: a mid-pipeline ffmpeg failure still cleans up work/ (finally), leaving no develop.json/mp4 marker but real re-runnable partial products", async () => {
    const takeId = "take-20260101-0000-fa11";
    const { manifestPath } = await buildValidTake(takeId, { video: false, receivedFrom: "NIGHTINGALE" });

    const localPcm = buildAudioTrack(8, [1.0, 6.5]);
    const remotePcm = buildAudioTrack(8, [1.0, 6.4988]);

    // Fail on the mix's measure pass (mid-pipeline — well after raw/ and
    // stems/ have real content, before any receipt or mp4 exists).
    const fakeRunner = makeFakeRunner({
      onRun: (args) => {
        if (args[args.length - 1] === "-" && args.some((a) => typeof a === "string" && a.includes("amix=inputs=2:normalize=0"))) {
          throw new DarkroomError("ffmpeg-failed", "simulated mix measure failure");
        }
      },
    });
    const deps = {
      runner: fakeRunner,
      renderBackdrop: NEVER_CALLED,
      decodeMarkWindows: makeFakeDecodeMarkWindows(localPcm, remotePcm),
      now: () => "2026-01-01T00:00:00.000Z",
    };

    await expect(developEpisode(deps, manifestPath, { ownCodename: "CARDINAL" })).rejects.toMatchObject({
      code: "ffmpeg-failed",
    });

    const episodesRoot = path.join(tmpRoot, "episodes", takeId);
    // work/ (concat temporaries, any backdrop.png) is gone even on failure.
    expect(fs.existsSync(path.join(episodesRoot, "work"))).toBe(false);
    // No marker, no half-written episode.m4a — the mix apply pass never ran.
    expect(fs.existsSync(path.join(episodesRoot, "develop.json"))).toBe(false);
    expect(fs.existsSync(path.join(episodesRoot, "episode.m4a"))).toBe(false);
    // But the real, already-completed upstream work survives, re-runnable:
    expect(fs.existsSync(path.join(episodesRoot, "raw", "local-audio.webm"))).toBe(true);
    expect(fs.existsSync(path.join(episodesRoot, "stems", "CARDINAL.m4a"))).toBe(true);
  }, 20000);
});

describe("index.mjs — CLI arg parsing", () => {
  it("parses all flags, applying D12's defaults for the ones omitted", () => {
    const opts = parseArgs(["--vault", "/tmp/vault", "--develop", "/tmp/vault/take-x/episode.json"]);
    expect(opts).toEqual({
      vault: "/tmp/vault",
      ownCodename: "HOST",
      model: "server/models/std.rnnn",
      develop: "/tmp/vault/take-x/episode.json",
      pollMs: 5000,
    });
  });

  it("overrides every default when given explicitly", () => {
    const opts = parseArgs([
      "--vault",
      "/tmp/vault",
      "--own-codename",
      "CARDINAL",
      "--model",
      "/models/custom.rnnn",
      "--poll-ms",
      "1500",
    ]);
    expect(opts).toEqual({
      vault: "/tmp/vault",
      ownCodename: "CARDINAL",
      model: "/models/custom.rnnn",
      develop: null,
      pollMs: 1500,
    });
  });

  it("missing --vault is a cli-invalid refusal", () => {
    expect(() => parseArgs(["--poll-ms", "1000"])).toThrow(/cli-invalid/);
  });

  it("unknown flag is a cli-invalid refusal", () => {
    expect(() => parseArgs(["--vault", "/tmp/vault", "--bogus"])).toThrow(/cli-invalid/);
  });
});

describe("index.mjs — pollOnce watcher pass", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-watch-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  function writeMinimalManifest(takeDir: string, takeId: string): Promise<void> {
    return fsp.writeFile(
      path.join(takeDir, "episode.json"),
      JSON.stringify({
        version: 1,
        episodeId: takeId,
        receivedFrom: null,
        completedAt: "2026-01-01T00:00:00.000Z",
        local: null,
        remote: { audio: [], video: [] },
      }),
    );
  }

  it("watcher skips takes with develop.json present (D22); --develop reruns them (direct call bypasses the marker)", async () => {
    const takeIdA = "take-20260101-0000-aaaa"; // already developed
    const takeIdB = "take-20260101-0000-bbbb"; // needs developing

    for (const takeId of [takeIdA, takeIdB]) {
      const takeDir = path.join(tmpRoot, takeId);
      await fsp.mkdir(takeDir, { recursive: true });
      await writeMinimalManifest(takeDir, takeId);
    }
    // Pre-existing developed marker for A (D22: develop.json present == developed).
    await fsp.mkdir(path.dirname(developedMarkerPath(tmpRoot, takeIdA)), { recursive: true });
    await fsp.writeFile(developedMarkerPath(tmpRoot, takeIdA), "{}");

    const develCalls: string[] = [];
    const fakeDevelop = async (_deps: unknown, manifestPath: string) => {
      develCalls.push(manifestPath);
    };

    const results = await pollOnce({ developEpisode: fakeDevelop, scanVault }, {}, tmpRoot, {}, { error: () => {} });

    expect(results).toEqual(
      expect.arrayContaining([
        { takeId: takeIdA, status: "skipped" },
        { takeId: takeIdB, status: "developed" },
      ]),
    );
    // The watcher never even calls developEpisode for the already-developed take.
    expect(develCalls).toEqual([path.join(tmpRoot, takeIdB, "episode.json")]);

    // --develop bypasses the marker entirely — index.mjs's one-shot path
    // calls developEpisode directly, never consulting isDeveloped/pollOnce.
    // A direct call on A's manifest (already "developed") still runs.
    await fakeDevelop({}, path.join(tmpRoot, takeIdA, "episode.json"));
    expect(develCalls).toEqual([
      path.join(tmpRoot, takeIdB, "episode.json"),
      path.join(tmpRoot, takeIdA, "episode.json"),
    ]);
    expect(await isDeveloped(tmpRoot, takeIdA)).toBe(true);
  });

  it("a refusal is logged loudly (single code prefix, no doubling — IMPORTANT 5) and does not halt the pass — sources untouched, retried next call", async () => {
    const takeId = "take-20260101-0000-cccc";
    const takeDir = path.join(tmpRoot, takeId);
    await fsp.mkdir(takeDir, { recursive: true });
    await writeMinimalManifest(takeDir, takeId);

    const err = Object.assign(new Error("part-gap: boom"), { code: "part-gap", name: "DarkroomError" });
    Object.setPrototypeOf(err, (await import("../scripts/darkroom/errors.mjs")).DarkroomError.prototype);
    const fakeDevelop = async () => {
      throw err;
    };
    const logged: string[] = [];

    const results = await pollOnce(
      { developEpisode: fakeDevelop, scanVault },
      {},
      tmpRoot,
      {},
      { error: (msg: string) => logged.push(msg) },
    );

    expect(results).toEqual([{ takeId, status: "refused", code: "part-gap" }]);
    expect(logged.length).toBe(1);
    // Exactly one "part-gap:" prefix — err.message ("part-gap: boom") is
    // used as-is, not prefixed with the code a second time.
    expect(logged[0]).toBe(`darkroom: part-gap: boom (take ${takeId} — sources untouched, will retry next poll)`);
    expect(logged[0].match(/part-gap/g)?.length).toBe(1);

    // Re-polling retries it (no in-memory state remembers the refusal).
    const secondPass = await pollOnce(
      { developEpisode: fakeDevelop, scanVault },
      {},
      tmpRoot,
      {},
      { error: (msg: string) => logged.push(msg) },
    );
    expect(secondPass).toEqual([{ takeId, status: "refused", code: "part-gap" }]);
  });

  it("CRITICAL 1: a scanVault failure is logged loudly and swallowed — the watcher keeps polling instead of throwing an unhandled rejection", async () => {
    let calls = 0;
    const flakyScanVault = async (dir: string) => {
      calls += 1;
      if (calls === 1) throw new Error("EACCES: permission denied, scandir '" + dir + "'");
      return [];
    };
    const logged: string[] = [];
    const fakeDevelop = async () => {
      throw new Error("should not be called — nothing to develop in this test");
    };

    const firstPass = await pollOnce(
      { developEpisode: fakeDevelop, scanVault: flakyScanVault },
      {},
      tmpRoot,
      {},
      { error: (msg: string) => logged.push(msg) },
    );
    expect(firstPass).toEqual([]);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("darkroom: scan-failed:");
    expect(logged[0]).toContain("EACCES");

    // The NEXT call (what the poll loop does every interval) is entirely
    // unaffected — no crash, no leftover state from the failed scan.
    const secondPass = await pollOnce(
      { developEpisode: fakeDevelop, scanVault: flakyScanVault },
      {},
      tmpRoot,
      {},
      { error: (msg: string) => logged.push(msg) },
    );
    expect(secondPass).toEqual([]);
    expect(calls).toBe(2);
    expect(logged.length).toBe(1); // no new log entries — the second call succeeded
  });
});

// ---------------------------------------------------------------------------
// resolveChromePath — arch-aware executable resolution (5C punch list)
// ---------------------------------------------------------------------------
describe("resolveChromePath", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-chrome-"));
  });
  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  async function seedShell(revision: number, archSegment: string): Promise<string> {
    const bin = path.join(
      tmpRoot,
      `chromium_headless_shell-${revision}`,
      `chrome-headless-shell-${archSegment}`,
      "chrome-headless-shell",
    );
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    await fsp.writeFile(bin, "");
    return bin;
  }

  it("resolves the arm64 binary on an arm64 Mac — the hardcoded x64 segment died at startup there", async () => {
    const bin = await seedShell(1200, "mac-arm64");
    expect(resolveChromePath({ root: tmpRoot, arch: "arm64" })).toBe(bin);
  });

  it("still resolves the x64 binary on x64, picking the HIGHEST cached revision", async () => {
    await seedShell(1100, "mac-x64");
    const newest = await seedShell(1200, "mac-x64");
    expect(resolveChromePath({ root: tmpRoot, arch: "x64" })).toBe(newest);
  });

  it("a cached revision without this arch's binary is a clear DarkroomError naming the install fix, not a later spawn ENOENT", async () => {
    await seedShell(1200, "mac-x64"); // stale x64 cache on an arm64 machine
    expect(() => resolveChromePath({ root: tmpRoot, arch: "arm64" })).toThrowError(DarkroomError);
    expect(() => resolveChromePath({ root: tmpRoot, arch: "arm64" })).toThrowError(/playwright-core install/);
  });

  it("an empty cache root stays the existing no-build DarkroomError", async () => {
    expect(() => resolveChromePath({ root: tmpRoot, arch: "x64" })).toThrowError(/no chromium_headless_shell build/);
  });
});

// ---------------------------------------------------------------------------
// refusal backoff — deterministically-refused takes stop re-running the full
// pipeline every poll (5C punch list), without breaking the copy-fallback's
// unparseable-manifest self-heal (first retry is still the very next poll).
// ---------------------------------------------------------------------------
describe("pollOnce refusal backoff", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-backoff-"));
  });
  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const take = { takeId: "take-1", manifestPath: "unused" };
  const quiet = { error: () => {} };

  function harness(develop: () => Promise<void>) {
    return {
      fns: { scanVault: async () => [take], developEpisode: develop },
      backoff: makeRefusalBackoff(),
    };
  }

  it("first refusal retries on the very next poll — the manifest self-heal window stays one poll wide", async () => {
    let calls = 0;
    const { fns, backoff } = harness(async () => {
      calls += 1;
      if (calls === 1) throw new DarkroomError("manifest-unreadable", "manifest-unreadable: transient");
    });
    const p1 = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff);
    expect(p1).toEqual([{ takeId: "take-1", status: "refused", code: "manifest-unreadable" }]);
    const p2 = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff);
    expect(p2).toEqual([{ takeId: "take-1", status: "developed" }]);
    expect(calls).toBe(2);
  });

  it("consecutive refusals back off exponentially — attempts thin out instead of re-running every poll", async () => {
    let calls = 0;
    const { fns, backoff } = harness(async () => {
      calls += 1;
      throw new DarkroomError("part-gap", "part-gap: deterministic");
    });
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff);
      statuses.push(r[0]!.status);
    }
    // p1 refused (f=1, +1) -> p2 refused (f=2, +2) -> p3 deferred -> p4
    // refused (f=3, +4) -> p5 deferred; 3 real attempts in 5 polls.
    expect(statuses).toEqual(["refused", "refused", "deferred", "refused", "deferred"]);
    expect(calls).toBe(3);
  });

  it("a successful develop resets the take's backoff entirely", async () => {
    let failNext = true;
    let calls = 0;
    const { fns, backoff } = harness(async () => {
      calls += 1;
      if (failNext) throw new DarkroomError("part-gap", "part-gap: flaky");
    });
    await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff); // refused (f=1)
    failNext = false;
    const healed = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff);
    expect(healed[0]!.status).toBe("developed");
    // Marker isn't written by the fake, so the take is re-attempted; break it
    // again — a reset take must retry NEXT poll (f back to 1), not inherit
    // the earlier failure count.
    failNext = true;
    const r3 = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff); // refused (f=1, +1)
    const r4 = await pollOnce(fns, {}, tmpRoot, {}, quiet, backoff); // eligible again immediately
    expect(r3[0]!.status).toBe("refused");
    expect(r4[0]!.status).toBe("refused");
    expect(calls).toBe(4);
  });

  it("without a backoff instance, every poll retries — the shipped pre-backoff behavior", async () => {
    let calls = 0;
    const fns = {
      scanVault: async () => [take],
      developEpisode: async () => {
        calls += 1;
        throw new DarkroomError("part-gap", "part-gap: deterministic");
      },
    };
    await pollOnce(fns, {}, tmpRoot, {}, quiet);
    await pollOnce(fns, {}, tmpRoot, {}, quiet);
    await pollOnce(fns, {}, tmpRoot, {}, quiet);
    expect(calls).toBe(3);
  });
});
