// VideoTile's screenShare variant: a document is not a face. The video must
// letterbox (object-contain — cover-cropping a screen amputates its edges).
// Audio: a screen shared WITHOUT sound stays muted with no Mute control
// (nothing to restore); one shared WITH tab/system audio plays it on remote
// tiles exactly like a face's voice (Mute + Restore Audio), and the sharer's
// own preview never does.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import VideoTile from "@/components/VideoTile";

afterEach(cleanup);

function fakeStream(withAudio = false): MediaStream {
  return {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
    getAudioTracks: () => (withAudio ? [{ kind: "audio" }] : []),
  } as unknown as MediaStream;
}

let mutedAtPlay: boolean[];

beforeEach(() => {
  mutedAtPlay = [];
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    mutedAtPlay.push(this.muted);
    return Promise.resolve();
  };
  // jsdom never implements fullscreen — model "nothing is fullscreen".
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
});

/** Poses the fullscreen state jsdom can't produce natively. */
function fullscreenIs(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => el });
  fireEvent(document, new Event("fullscreenchange"));
}

test("a screen tile letterboxes instead of cover-cropping", () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Your Screen" screenShare />);
  const video = container.querySelector("video")!;
  expect(video.className).toContain("object-contain");
  expect(video.className).not.toContain("object-cover");
});

test("a face tile still cover-crops", () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 2" />);
  expect(container.querySelector("video")!.className).toContain("object-cover");
});

// 8/11 second live-test round: even the dominant tile is too small for a
// text-heavy share. The reading mode is the browser's native fullscreen —
// Permissions-Policy already grants fullscreen=(self) — toggled per tile.
test("a screen tile offers Full Screen, and clicking it fullscreens the tile", () => {
  const requestFullscreen = vi.fn(async () => {});
  window.HTMLElement.prototype.requestFullscreen = requestFullscreen;
  render(<VideoTile stream={fakeStream()} label="Agent 2's Screen" screenShare />);

  fireEvent.click(screen.getByRole("button", { name: /full screen/i }));

  expect(requestFullscreen).toHaveBeenCalledOnce();
});

// 8/11 third round: full screen should not mean losing sight of the faces.
// The overlay renders INSIDE the figure (fullscreen shows only that
// subtree) and ONLY while this tile owns fullscreen — in the tile view the
// faces already have their own strip/column, and a duplicate would clutter.
test("the fullscreen overlay renders only while the tile owns fullscreen", () => {
  window.HTMLElement.prototype.requestFullscreen = vi.fn(async () => {});
  const { container } = render(
    <VideoTile stream={fakeStream()} label="Agent 2's Screen" screenShare fullscreenOverlay={<p>thumb-row</p>} />,
  );
  const figure = container.querySelector("figure")!;

  expect(screen.queryByText("thumb-row")).toBeNull(); // tile view — no overlay

  fullscreenIs(figure);
  expect(screen.getByText("thumb-row")).toBeTruthy();

  fullscreenIs(null); // Esc
  expect(screen.queryByText("thumb-row")).toBeNull();
});

test("a face tile offers no Full Screen control", () => {
  render(<VideoTile stream={fakeStream()} label="Agent 2" />);
  expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();
});

// Screen-share audio (the sharer ticked "Share tab audio"): the remote screen
// tile plays it — same unmuted-from-the-first-frame stance as a face tile,
// same per-tile Mute and Restore Audio machinery.
test("a remote screen tile WITH audio plays it unmuted and offers a Mute control", async () => {
  const { container } = render(<VideoTile stream={fakeStream(true)} label="Agent 2's Screen" screenShare />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay).toContain(false));
  expect(video.muted).toBe(false);
  const mute = screen.getByRole("button", { name: "Mute Agent 2's Screen" });
  expect(screen.getByRole("button", { name: /full screen/i })).toBeTruthy(); // both controls coexist

  fireEvent.click(mute);
  expect(video.muted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Unmute Agent 2's Screen" }));
  expect(video.muted).toBe(false);
});

test("a screen tile whose unmuted playback is refused falls back to Restore Audio", async () => {
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    return this.muted ? Promise.resolve() : Promise.reject(new DOMException("no gesture", "NotAllowedError"));
  };
  render(<VideoTile stream={fakeStream(true)} label="Agent 2's Screen" screenShare />);

  expect(await screen.findByRole("button", { name: /restore audio/i })).toBeTruthy();
});

// The sharer's own preview must never play the tab's sound back — they
// already hear the tab itself, and a second copy is an echo source.
test("your own screen tile stays muted even when the capture has audio", async () => {
  const { container } = render(<VideoTile stream={fakeStream(true)} label="Your Screen" screenShare isSelf />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay.length).toBeGreaterThan(0));
  expect(video.muted).toBe(true);
  expect(mutedAtPlay).not.toContain(false);
  expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
});

test("a remote screen tile without audio stays muted and offers no Mute control", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 2's Screen" screenShare />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay.length).toBeGreaterThan(0));
  expect(video.muted).toBe(true);
  expect(mutedAtPlay).not.toContain(false); // no unmuted attempt → no Restore Audio path either
  expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
});
