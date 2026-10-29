// The live room's episode stage (2026-10-29): while a two-person take rolls,
// the face grid becomes the darkroom's 1920x1080 frame — two pane columns,
// the cream divider between them at its true share of the width. Numbers
// come from lib/podcast/episodeGeometry.mjs (the darkroom's own source).
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import EpisodeStage, { episodeStageStyle } from "@/components/EpisodeStage";

afterEach(cleanup);

test("staged: a 16:9 box, divider-width column gap, divider colour behind it", () => {
  const s = episodeStageStyle(true);
  // jsdom drops cqw/cqh-mixed values from element.style, so the formulas are
  // pinned on the function the JSX builds its style from.
  expect(s.width).toBe("min(100cqw, calc(100cqh * (1920 / 1080)))");
  expect(s.height).toBe("min(100cqh, calc(100cqw * (1080 / 1920)))");
  expect(parseFloat(String(s.columnGap))).toBeCloseTo((4 / 1920) * 100, 5);
  expect(s.backgroundColor).toBe("#F7EED8");
  expect("aspectRatio" in s).toBe(false);
});

test("not staged: plain full fill, no divider colour", () => {
  expect(episodeStageStyle(false)).toEqual({ width: "100cqw", height: "100cqh" });
});

test("staged grid is two columns, one row; unstaged uses the room's grid classes", () => {
  const r = render(
    <EpisodeStage staged gridClass="grid-cols-1 sm:grid-cols-2">
      <div>left</div>
      <div>right</div>
    </EpisodeStage>,
  );
  const stage = r.getByTestId("episode-stage");
  expect(stage.className).toContain("grid-cols-2");
  expect(stage.className).toContain("grid-rows-1");
  expect(stage.className).not.toContain("gap-3");
  expect(stage.style.backgroundColor).toBe("rgb(247, 238, 216)");
  expect(stage.style.columnGap).toMatch(/%$/);

  r.rerender(
    <EpisodeStage staged={false} gridClass="grid-cols-1 sm:grid-cols-2">
      <div>left</div>
      <div>right</div>
    </EpisodeStage>,
  );
  expect(r.queryByTestId("episode-stage")).toBeNull();
});

test("staging toggles on the SAME nodes — tiles inside are never remounted", () => {
  const Probe = () => <video data-testid="probe" />;
  const r = render(
    <EpisodeStage staged={false} gridClass="grid-cols-2">
      <Probe />
    </EpisodeStage>,
  );
  const video = r.getByTestId("probe");
  const grid = video.parentElement;
  r.rerender(
    <EpisodeStage staged gridClass="grid-cols-2">
      <Probe />
    </EpisodeStage>,
  );
  expect(r.getByTestId("probe")).toBe(video);
  expect(r.getByTestId("probe").parentElement).toBe(grid);
});
