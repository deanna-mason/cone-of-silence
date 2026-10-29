// @vitest-environment node
//
// The ONE podcast episode frame (lib/podcast/episodeGeometry.mjs), shared by
// the darkroom composite and the live room preview. These pin the numbers
// (Series 2 frame, decided 2026-10-28) and the invariants that keep the two
// consumers honest: the panes + divider tile the frame exactly, the ffmpeg
// crop and the CSS preview box are derived from the same integers, and the
// crop never shows more than the pane.
import { describe, it, expect } from "vitest";
import {
  FRAME,
  DIVIDER,
  PANE,
  CAMERA_CROP,
  EDGE_TO_EDGE_LAYOUT,
  DIVIDER_FRACTION_OF_WIDTH,
  coverBox,
  ffmpegPaneFilters,
  previewVideoBox,
} from "../lib/podcast/episodeGeometry.mjs";

describe("episodeGeometry — the frame", () => {
  it("pins the Series 2 numbers", () => {
    expect(FRAME).toEqual({ w: 1920, h: 1080 });
    expect(PANE).toEqual({ w: 958, h: 1080 });
    expect(DIVIDER).toEqual({ w: 4, color: "#F7EED8" });
    expect(CAMERA_CROP).toEqual({ zoom: 1.08, topPx: 4 });
    expect(DIVIDER_FRACTION_OF_WIDTH).toBeCloseTo(4 / 1920, 12);
  });

  it("left pane + divider + right pane tile the full frame, edge to edge, no margins", () => {
    const { left, right } = EDGE_TO_EDGE_LAYOUT;
    expect(left).toMatchObject({ x: 0, y: 0, w: 958, h: 1080 });
    expect(right).toMatchObject({ x: 962, y: 0, w: 958, h: 1080 });
    expect(left.x + left.w + DIVIDER.w).toBe(right.x);
    expect(right.x + right.w).toBe(FRAME.w);
    expect(left.h).toBe(FRAME.h);
    expect(left.crop).toBe(CAMERA_CROP);
    expect(right.crop).toBe(CAMERA_CROP);
  });

  it("is frozen — no caller can nudge the shared geometry at runtime", () => {
    expect(Object.isFrozen(PANE)).toBe(true);
    expect(Object.isFrozen(EDGE_TO_EDGE_LAYOUT.left)).toBe(true);
    expect(Object.isFrozen(CAMERA_CROP)).toBe(true);
  });
});

describe("episodeGeometry — crop rule", () => {
  it("cover box is the pane x1.08, rounded (the Hamlet S2E1 post crop)", () => {
    expect(coverBox(PANE, CAMERA_CROP)).toEqual({ w: 1035, h: 1166 });
  });

  it("ffmpeg: cover-scale to the box, then crop the pane centred, 4px from the top", () => {
    expect(ffmpegPaneFilters(PANE, CAMERA_CROP)).toEqual([
      "scale=1035:1166:force_original_aspect_ratio=increase",
      "crop=958:1080:(iw-958)/2:4",
    ]);
  });

  it("ffmpeg with no crop rule = the legacy plain centre cover-crop, string-identical", () => {
    expect(ffmpegPaneFilters({ w: 930, h: 1008 })).toEqual([
      "scale=930:1008:force_original_aspect_ratio=increase",
      "crop=930:1008",
    ]);
  });

  it("preview box is the same cover box, centred and raised by topPx, cover + top anchor", () => {
    const box = previewVideoBox(PANE, CAMERA_CROP);
    expect(box.objectPosition).toBe("50% 0");
    const n = (v: string) => parseFloat(v) / 100;
    // Same integers as ffmpeg: 1035x1166 over a 958x1080 pane (to 1/100 px —
    // the percentages carry 6 decimals).
    expect(n(box.width) * PANE.w).toBeCloseTo(1035, 2);
    expect(n(box.height) * PANE.h).toBeCloseTo(1166, 2);
    // Centred horizontally: (1035 - 958) / 2 = 38.5px hang off each side.
    expect(-n(box.left) * PANE.w).toBeCloseTo(38.5, 2);
    // Top-anchored: the pane starts 4px below the box's top edge.
    expect(-n(box.top) * PANE.h).toBeCloseTo(4, 2);
  });

  it("privacy: refuses a crop that would show more than a full pane or slide off the image", () => {
    expect(() => coverBox(PANE, { zoom: 0.9, topPx: 0 })).toThrow(/below 1/);
    expect(() => coverBox(PANE, { zoom: 1.08, topPx: 200 })).toThrow(/outside/);
    expect(() => coverBox(PANE, { zoom: 1.08, topPx: -1 })).toThrow(/outside/);
  });
});
