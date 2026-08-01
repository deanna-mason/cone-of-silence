// @vitest-environment node
//
// Task 5: composite arg-builder cases only (contain-scale+pad, remote-only
// setpts ordering, audio/encoding invariants). renderBackdrop launches real
// headless Chrome and is exercised by the e2e (e2e/darkroom-e2e.js, Task 7)
// and by the one-off local hand-check render — not unit-tested here.
//
// Task 6 extends this same file with developEpisode/CLI orchestration cases.
import { describe, it, expect } from "vitest";

import { compositeArgs } from "../scripts/darkroom/composite.mjs";

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
  it("contain-scale+pad into both pane rects, overlay coords from layout", () => {
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

    // object-fit: contain == scale-to-fit (decrease) + center pad, per pane's OWN w/h.
    expect(fc).toContain("scale=820:615:force_original_aspect_ratio=decrease");
    expect(fc).toContain("pad=820:615:(ow-iw)/2:(oh-ih)/2");
    expect(fc).toContain("scale=800:600:force_original_aspect_ratio=decrease");
    expect(fc).toContain("pad=800:600:(ow-iw)/2:(oh-ih)/2");

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
    // contain scale/pad that feeds the overlay.
    expect(remoteSeg).toContain("setpts=PTS*0.999800000");
    const setptsPos = remoteSeg.indexOf("setpts=PTS*0.999800000");
    const tpadPos = remoteSeg.indexOf("tpad=");
    const scalePos = remoteSeg.indexOf("scale=");
    const padPos = remoteSeg.indexOf("pad=800:600");
    expect(tpadPos).toBeGreaterThan(-1);
    expect(setptsPos).toBeLessThan(tpadPos);
    expect(tpadPos).toBeLessThan(scalePos);
    expect(scalePos).toBeLessThan(padPos);
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

    // Duration-pin mechanism (video side, unchanged): the LOCAL overlay
    // stage (only) carries the per-filter overlay `shortest=1` option —
    // this bounds the video half of the filtergraph to local's length,
    // without using ffmpeg's global `-shortest` output flag for THIS
    // purpose (which would let a short remote win arbitrarily — the
    // reason the plan text banned it in the first place, per D21 above).
    expect(fc).toContain(":shortest=1");
    expect((fc.match(/:shortest=1/g) || []).length).toBe(1);
  });
});
