// Room visual decisions:
//   Speaking outline (8/4 dress-rehearsal rework, supersedes CS-DR-04's
//      two-tier 1A/3C grammar): ONE slim 1px inner brass line for every
//      speaking tile, self and remote alike. No bloom, no breathing pulse,
//      no caption dot. The outline is LATCHED by the room page
//      (useSpeakerLatch): tiles draw the latched prop, never the raw
//      detector — RemoteTile only reports its detector's rising edge up.
//      Brass only; vermilion stays reserved for danger.
//   2B "Iris Pan" — roll-tape framing: while a take rolls, BOTH tiles crop to
//      the 930:1008 episode pane, the viewport width AND height eased as plain
//      lengths (never aspect-ratio); a slate-stamp flashes on the roller's own
//      tile. prefers-reduced-motion → hard cut (no ease, no flash).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import VideoTile, { episodeViewportStyle } from "@/components/VideoTile";
import RemoteTile from "@/components/RemoteTile";
import { EPISODE_PANE_H, EPISODE_PANE_W } from "@/lib/podcast/paneAspect";

// The live per-tile detector, controllable per test. RemoteTile must treat
// it as report-only — the drawn outline comes from the latched `speaking`
// prop alone.
let mockLive = false;
vi.mock("@/hooks/useSpeaking", () => ({ useSpeaking: () => mockLive }));

beforeEach(() => {
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fakeStream(): MediaStream {
  return {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

/** Force the reduced-motion media query to a fixed answer for a test. */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion") ? matches : false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

// ── Speaking outline (one slim grammar, latched) ─────────────────────────
test("a speaking tile — remote or self — shows the slim brass outline, never a bloom or a dot", () => {
  const remote = render(<VideoTile stream={fakeStream()} label="Agent 2" speaking />);
  const remoteFig = remote.container.querySelector("figure")!;
  expect(remoteFig.className).toContain("speaking-tick");
  expect(remoteFig.className).not.toContain("speaking-bloom");
  // Brass only — the outline must never borrow the danger colour.
  expect(remoteFig.className).not.toContain("vermilion");
  cleanup();

  const self = render(<VideoTile stream={fakeStream()} label="You" isSelf speaking />);
  const selfFig = self.container.querySelector("figure")!;
  expect(selfFig.className).toContain("speaking-tick");
  expect(selfFig.className).not.toContain("speaking-bloom");
  // The old pulsing caption dot is retired everywhere.
  expect(self.queryByTestId("speaking-dot")).toBeNull();
});

test("a quiet tile shows no outline", () => {
  const { container, queryByTestId } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf />,
  );
  expect(container.querySelector("figure")!.className).not.toContain("speaking-tick");
  expect(queryByTestId("speaking-dot")).toBeNull();
});

test("a cut mic outranks the speaking outline on the self tile", () => {
  const { container } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf speaking micCut />,
  );
  const figure = container.querySelector("figure")!;
  expect(figure.className).toContain("ring-vermilion");
  expect(figure.className).not.toContain("speaking-tick");
});

test("RemoteTile reports its detector's rising edge up but draws only the latched prop", () => {
  const onSpeakingStart = vi.fn();
  const peer = {
    peerId: "p1",
    stream: fakeStream(),
    connectionState: "connected",
  } as unknown as import("@/lib/webrtc/session").RemotePeer;

  // Detector live, latch prop absent: the room hears about it, the tile
  // stays dark — drawing the raw detector is the per-word flashing the
  // rework removed.
  mockLive = true;
  const raw = render(<RemoteTile peer={peer} label="Agent 2" onSpeakingStart={onSpeakingStart} />);
  expect(onSpeakingStart).toHaveBeenCalledWith("p1");
  expect(raw.container.querySelector("figure")!.className).not.toContain("speaking-tick");
  cleanup();

  // Latch prop set, detector quiet: the outline holds.
  mockLive = false;
  const latched = render(<RemoteTile peer={peer} label="Agent 2" speaking />);
  expect(latched.container.querySelector("figure")!.className).toContain("speaking-tick");
});

// ── 2B Iris Pan (roll-tape framing) ──────────────────────────────────────
test("2B: episodeViewportStyle pins BOTH width and height as cqw/cqh lengths (no aspect-ratio)", () => {
  const rolling = episodeViewportStyle(true);
  expect(rolling.width).toBe(
    `min(100cqw, calc(100cqh * (${EPISODE_PANE_W} / ${EPISODE_PANE_H})))`,
  );
  expect(rolling.height).toBe(
    `min(100cqh, calc(100cqw * (${EPISODE_PANE_H} / ${EPISODE_PANE_W})))`,
  );
  // NEVER animate aspect-ratio — it must not appear.
  expect("aspectRatio" in rolling).toBe(false);
});

test("2B: the un-cropped viewport is a plain-length full fill (so the crop can ease from it)", () => {
  const full = episodeViewportStyle(false);
  expect(full.width).toBe("100cqw");
  expect(full.height).toBe("100cqh");
  expect("aspectRatio" in full).toBe(false);
});

test("2B: both self and remote tiles carry the episode crop viewport while rolling", () => {
  const self = render(<VideoTile stream={fakeStream()} label="You" isSelf episodeFrame />);
  expect(within(self.container).getByTestId("episode-viewport")).toBeDefined();

  const peer = {
    peerId: "p1",
    stream: fakeStream(),
    connectionState: "connected",
  } as unknown as import("@/lib/webrtc/session").RemotePeer;
  const remote = render(<RemoteTile peer={peer} label="Agent 2" episodeFrame />);
  expect(within(remote.container).getByTestId("episode-viewport")).toBeDefined();
});

test("2B: the roller's own tile flashes a slate stamp; the partner tile does not", () => {
  const self = render(<VideoTile stream={fakeStream()} label="You" isSelf episodeFrame />);
  const slate = within(self.container).getByTestId("slate-stamp");
  expect(slate.textContent).toMatch(/rolling/i);
  // The take number came off 8/5: it was hardcoded "01" on every take, so it
  // was wrong from the second take onward. The slate says only what it knows.
  expect(slate.textContent).not.toMatch(/\d/);
  expect(slate.className).toContain("slate-flash");

  const remote = render(<VideoTile stream={fakeStream()} label="Agent 2" episodeFrame />);
  expect(within(remote.container).queryByTestId("slate-stamp")).toBeNull();
});

// ── Reduced motion → hard cut ────────────────────────────────────────────
test("reduced motion: no eased iris transition, no slate flash; the static outline stays", () => {
  stubReducedMotion(true);

  const remote = render(<VideoTile stream={fakeStream()} label="Agent 2" speaking />);
  // The slim outline is static by design — it survives reduced motion.
  expect(remote.container.querySelector("figure")!.className).toContain("speaking-tick");
  cleanup();

  const self = render(
    <VideoTile stream={fakeStream()} label="You" isSelf speaking episodeFrame />,
  );
  expect(self.getByTestId("episode-viewport").className).not.toContain("iris-viewport");
  expect(self.queryByTestId("slate-stamp")).toBeNull();
});

test("normal motion: the iris viewport eases (transition class present)", () => {
  stubReducedMotion(false);
  const { getByTestId } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf episodeFrame />,
  );
  expect(getByTestId("episode-viewport").className).toContain("iris-viewport");
});

// ── Pinned invariant: the div>div>video tree never changes shape ─────────
test("invariant: the div>div>video tree is identical across a roll toggle (same <video> node)", () => {
  const { container, rerender } = render(<VideoTile stream={fakeStream()} label="You" isSelf />);
  const video = container.querySelector("video")!;
  const outerWrapper = video.parentElement!.parentElement!; // div>div>video
  const innerWrapper = video.parentElement!;

  const shape = () => {
    const v = container.querySelector("video")!;
    return [v, v.parentElement, v.parentElement!.parentElement];
  };
  const before = shape();

  rerender(<VideoTile stream={fakeStream()} label="You" isSelf episodeFrame speaking />);
  expect(shape()).toEqual(before);
  expect(container.querySelector("video")).toBe(video);
  expect(video.parentElement).toBe(innerWrapper);
  expect(video.parentElement!.parentElement).toBe(outerWrapper);

  rerender(<VideoTile stream={fakeStream()} label="You" isSelf />);
  expect(shape()).toEqual(before);
  expect(container.querySelector("video")).toBe(video);
});
