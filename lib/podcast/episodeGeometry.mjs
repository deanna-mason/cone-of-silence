// lib/podcast/episodeGeometry.mjs — THE podcast episode frame, defined once.
//
// Both halves of the podcast read these numbers from here, so they cannot
// drift apart:
//   • the darkroom (scripts/darkroom/composite.mjs + pipeline.mjs, plain
//     Node) builds the finished episode mp4 from them, and
//   • the live room (components/VideoTile.tsx + app/room/page.tsx) frames
//     each camera, while the tape rolls, to exactly the region the mp4 shows.
// Plain ESM + JSDoc on purpose: Node imports it with no build step, and the
// Next app imports it through tsconfig's allowJs.
//
// The frame (decided for Series 2, first used on Hamlet S2E1, 2026-10-28):
// edge to edge, no badge, no outlines, no dot. Two camera panes fill the
// 1920x1080 frame, separated by a thin cream divider.
//
//   x:  0 ............ 957 | 958..961 | 962 ........... 1919
//       LEFT pane 958x1080 | divider  | RIGHT pane 958x1080
//       (local host, D14)  | #F7EED8  | (remote host)
//
// Camera crop rule (the Hamlet S2E1 post-production crop, now the default):
// each camera is scaled to COVER a box 1.08x the pane, centred horizontally
// and anchored 4 px from its top, then cropped to the pane. The zoom pushes
// the frame's outer band — laptop edge, tablet corner, whatever sits at the
// edge of a room — out of the picture; the top anchor keeps heads in frame.
//
// PRIVACY: a raw camera frame can show a person's surroundings. Every pane
// is ALWAYS cropped to exactly its pane size (ffmpegPaneFilters ends in
// `crop=W:H`), and the two panes plus the divider tile the full frame, so no
// uncropped raw frame, and no part of one outside the crop, ever reaches the
// composite. The raw vault recordings stay uncropped as the archival record.

/** The finished episode frame. */
export const FRAME = Object.freeze({ w: 1920, h: 1080 });

/** The cream rule between the two panes. */
export const DIVIDER = Object.freeze({ w: 4, color: "#F7EED8" });

/** One camera pane — two of these plus the divider are exactly FRAME. */
export const PANE = Object.freeze({ w: (FRAME.w - DIVIDER.w) / 2, h: FRAME.h });

/** The camera crop rule applied inside every pane. `zoom` scales the cover
 *  box beyond the pane; `topPx` is how far below the scaled image's top
 *  edge the pane's top sits (output pixels). Horizontal is always centred. */
export const CAMERA_CROP = Object.freeze({ zoom: 1.08, topPx: 4 });

/** Pane rects in frame pixels (same {x,y,w,h} shape renderBackdrop returns),
 *  each carrying the crop rule its camera is framed with. Local LEFT,
 *  remote RIGHT (D14). */
export const EDGE_TO_EDGE_LAYOUT = Object.freeze({
  left: Object.freeze({ x: 0, y: 0, w: PANE.w, h: PANE.h, crop: CAMERA_CROP }),
  right: Object.freeze({ x: PANE.w + DIVIDER.w, y: 0, w: PANE.w, h: PANE.h, crop: CAMERA_CROP }),
});

/** The size of the cover box the camera is scaled into before the crop.
 *  Rounded to whole pixels — ffmpeg's scale needs integers, and the live
 *  preview derives its box from these same integers so both agree exactly.
 *  @param {{w: number, h: number}} pane
 *  @param {{zoom: number, topPx: number}} crop */
export function coverBox(pane, crop) {
  const w = Math.round(pane.w * crop.zoom);
  const h = Math.round(pane.h * crop.zoom);
  if (w < pane.w || h < pane.h) throw new Error(`crop zoom ${crop.zoom} is below 1 — it would show less than a full pane`);
  if (crop.topPx < 0 || crop.topPx > h - pane.h) {
    throw new Error(`crop topPx ${crop.topPx} is outside 0..${h - pane.h} for a ${w}x${h} cover box`);
  }
  return { w, h };
}

/** ffmpeg filters that frame one camera into `pane`: cover-scale, then crop
 *  to exactly the pane size. With no crop rule this is the legacy plain
 *  centre cover-crop (string-identical to the pre-2026-10-29 output, which
 *  callers outside this repo pattern-match on).
 *  @param {{w: number, h: number}} pane
 *  @param {{zoom: number, topPx: number} | undefined} [crop]
 *  @returns {string[]} */
export function ffmpegPaneFilters(pane, crop) {
  if (!crop) {
    return [`scale=${pane.w}:${pane.h}:force_original_aspect_ratio=increase`, `crop=${pane.w}:${pane.h}`];
  }
  const box = coverBox(pane, crop);
  return [
    `scale=${box.w}:${box.h}:force_original_aspect_ratio=increase`,
    `crop=${pane.w}:${pane.h}:(iw-${pane.w})/2:${crop.topPx}`,
  ];
}

/** The live preview's equivalent of ffmpegPaneFilters, as percentages of the
 *  pane-shaped viewport: a box the size of the cover box, centred
 *  horizontally and raised by topPx, in which the <video> is
 *  `object-fit: cover` at `object-position: 50% 0`. That is the same scale,
 *  the same centring and the same top anchor ffmpeg applies.
 *  @param {{w: number, h: number}} pane
 *  @param {{zoom: number, topPx: number}} crop */
export function previewVideoBox(pane, crop) {
  const box = coverBox(pane, crop);
  const pct = (n) => `${+(n * 100).toFixed(6)}%`;
  return {
    left: pct(-(box.w - pane.w) / 2 / pane.w),
    top: pct(-crop.topPx / pane.h),
    width: pct(box.w / pane.w),
    height: pct(box.h / pane.h),
    objectPosition: "50% 0",
  };
}

/** The divider as a fraction of the frame width — the live stage's gap. */
export const DIVIDER_FRACTION_OF_WIDTH = DIVIDER.w / FRAME.w;
