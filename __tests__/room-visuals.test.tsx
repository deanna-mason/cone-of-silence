// CS-DR-04 room visual decisions (Deanna-approved 2026-08-03):
//   1A "Lamplight Bloom" — partner (remote) speaking glow: 3px full-opacity
//      brass ring + a breathing outer glow. Brass only; vermilion stays
//      reserved for danger.
//   3C "Needle Tick" — self speaking: a subdued 1px INNER brass line + a
//      pulsing brass dot in the "You" caption. Two-tier grammar: tick = you,
//      full bloom = them. The self tile NEVER gets the full bloom.
//   2B "Iris Pan" — roll-tape framing: while a take rolls, BOTH tiles crop to
//      the 930:1008 episode pane, the viewport width AND height eased as plain
//      lengths (never aspect-ratio); a slate-stamp flashes on the roller's own
//      tile. prefers-reduced-motion → hard cut (no ease, no pulse, no flash).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import VideoTile, { episodeViewportStyle } from "@/components/VideoTile";
import RemoteTile from "@/components/RemoteTile";
import { EPISODE_PANE_H, EPISODE_PANE_W } from "@/lib/podcast/paneAspect";

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

// ── 1A Lamplight Bloom (remote) ──────────────────────────────────────────
test("1A: a speaking remote tile shows the lamplight bloom (brass), not the self tick", () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 2" speaking />);
  const figure = container.querySelector("figure")!;
  expect(figure.className).toContain("speaking-bloom");
  expect(figure.className).not.toContain("speaking-tick");
  // Brass only — the bloom must never borrow the danger colour.
  expect(figure.className).not.toContain("vermilion");
});

test("1A: the bloom breathes under normal motion", () => {
  stubReducedMotion(false);
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 2" speaking />);
  expect(container.querySelector("figure")!.className).toContain("is-breathing");
});

// ── 3C Needle Tick (self) ────────────────────────────────────────────────
test("3C: a speaking self tile shows the needle tick, never the full bloom", () => {
  const { container, getByTestId } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf speaking />,
  );
  const figure = container.querySelector("figure")!;
  expect(figure.className).toContain("speaking-tick");
  expect(figure.className).not.toContain("speaking-bloom");
  // The pulsing brass dot lives in the caption.
  expect(getByTestId("speaking-dot")).toBeDefined();
});

test("3C: a quiet self tile shows neither tick nor dot", () => {
  const { container, queryByTestId } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf />,
  );
  expect(container.querySelector("figure")!.className).not.toContain("speaking-tick");
  expect(queryByTestId("speaking-dot")).toBeNull();
});

test("3C: a cut mic outranks the speaking tick on the self tile", () => {
  const { container, queryByTestId } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf speaking micCut />,
  );
  const figure = container.querySelector("figure")!;
  expect(figure.className).toContain("ring-vermilion");
  expect(figure.className).not.toContain("speaking-tick");
  expect(figure.className).not.toContain("speaking-bloom");
  expect(queryByTestId("speaking-dot")).toBeNull();
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
  expect(slate.textContent).toMatch(/take 01/i);
  expect(slate.className).toContain("slate-flash");

  const remote = render(<VideoTile stream={fakeStream()} label="Agent 2" episodeFrame />);
  expect(within(remote.container).queryByTestId("slate-stamp")).toBeNull();
});

// ── Reduced motion → hard cut ────────────────────────────────────────────
test("reduced motion: no bloom breathing, no eased iris transition, no slate flash, no pulsing dot", () => {
  stubReducedMotion(true);

  const remote = render(<VideoTile stream={fakeStream()} label="Agent 2" speaking />);
  const remoteFig = remote.container.querySelector("figure")!;
  expect(remoteFig.className).toContain("speaking-bloom"); // the ring stays — it's the indicator
  expect(remoteFig.className).not.toContain("is-breathing"); // but it does not breathe
  cleanup();

  const self = render(
    <VideoTile stream={fakeStream()} label="You" isSelf speaking episodeFrame />,
  );
  expect(self.getByTestId("episode-viewport").className).not.toContain("iris-viewport");
  expect(self.queryByTestId("slate-stamp")).toBeNull();
  expect(self.getByTestId("speaking-dot").className).not.toContain("animate-pulse");
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
