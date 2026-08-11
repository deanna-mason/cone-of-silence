// VideoTile's screenShare variant: a document is not a face. The video must
// letterbox (object-contain — cover-cropping a screen amputates its edges),
// playback stays muted (a screen track carries no audio; the Restore Audio
// machinery has nothing to restore), and the per-agent Mute control renders
// only on face tiles.
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import VideoTile from "@/components/VideoTile";

afterEach(cleanup);

function fakeStream(): MediaStream {
  return {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
  } as unknown as MediaStream;
}

let mutedAtPlay: boolean[];

beforeEach(() => {
  mutedAtPlay = [];
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    mutedAtPlay.push(this.muted);
    return Promise.resolve();
  };
});

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

test("a remote screen tile stays muted and offers no Mute control", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 2's Screen" screenShare />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay.length).toBeGreaterThan(0));
  expect(video.muted).toBe(true);
  expect(mutedAtPlay).not.toContain(false); // no unmuted attempt → no Restore Audio path either
  expect(screen.queryByRole("button", { name: /mute/i })).toBeNull();
});
