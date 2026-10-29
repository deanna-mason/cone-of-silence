// components/EpisodeStage.tsx
// The room's face grid, which becomes the finished episode's frame while a
// two-person take rolls (2026-10-29: "be looking at what we will actually
// see in the final cut, dimensions-wise, while we're filming").
//
// Staged, it is a 16:9 box (the darkroom's 1920x1080 frame, scaled to fit)
// holding two columns — self LEFT, partner RIGHT, as the darkroom places
// local/remote (D14) — separated by the cream divider at its true
// proportion of the frame width. Each column is then exactly one 958:1080
// pane, and each VideoTile crops its camera into it with the darkroom's own
// rule. Every number comes from lib/podcast/episodeGeometry.mjs.
//
// Persistent nodes: staged or not, it is the SAME size-container div and
// the SAME grid div — only their style/className change — so the tiles
// inside are never remounted (a remount drops a <video>'s srcObject).
"use client";

import type { CSSProperties, ReactNode } from "react";
import { DIVIDER, DIVIDER_FRACTION_OF_WIDTH, FRAME } from "@/lib/podcast/episodeGeometry.mjs";

/** The grid's inline style. Staged: the largest 16:9 box that fits the
 *  container (cqw/cqh, like the tile viewport), a column gap of the
 *  divider's share of the frame width, and the divider colour behind it so
 *  the gap reads as the divider. Not staged: a plain full fill. */
export function episodeStageStyle(staged: boolean): CSSProperties {
  if (!staged) return { width: "100cqw", height: "100cqh" };
  return {
    width: `min(100cqw, calc(100cqh * (${FRAME.w} / ${FRAME.h})))`,
    height: `min(100cqh, calc(100cqw * (${FRAME.h} / ${FRAME.w})))`,
    columnGap: `${+(DIVIDER_FRACTION_OF_WIDTH * 100).toFixed(6)}%`,
    rowGap: 0,
    backgroundColor: DIVIDER.color,
  };
}

export default function EpisodeStage({
  staged,
  gridClass,
  children,
}: {
  /** True while a take rolls with exactly two faces and no shared screen. */
  staged: boolean;
  /** The room's usual responsive grid classes, used when not staged. */
  gridClass: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" style={{ containerType: "size" }}>
      <div
        data-testid={staged ? "episode-stage" : undefined}
        className={`grid min-h-0 ${staged ? "grid-cols-2 grid-rows-1" : `gap-3 ${gridClass}`}`}
        style={episodeStageStyle(staged)}
      >
        {children}
      </div>
    </div>
  );
}
