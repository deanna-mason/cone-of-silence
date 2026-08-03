// Audio-on-join spec (docs/superpowers/specs/2026-08-03-audio-on-join-design.md):
// remote tiles are audible the moment a stream binds; blocked autoplay falls
// back to muted playback plus the front-and-center Restore Audio treatment.
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import VideoTile from "@/components/VideoTile";

afterEach(cleanup);

function fakeStream(): MediaStream {
  return {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
  } as unknown as MediaStream;
}

// jsdom's play() is unimplemented, and an element's muted=false is also the
// jsdom default — so record muted-ness at each play() attempt, letting tests
// assert that an *unmuted* attempt actually happened.
let mutedAtPlay: boolean[];

function installPlay(impl?: (muted: boolean) => Promise<void>) {
  mutedAtPlay = [];
  window.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    mutedAtPlay.push(this.muted);
    return impl ? impl(this.muted) : Promise.resolve();
  };
}

beforeEach(() => installPlay());

// Simulates a strict autoplay policy: muted playback always starts, unmuted
// playback is refused.
const blockUnmuted = (muted: boolean) =>
  muted
    ? Promise.resolve()
    : Promise.reject(new DOMException("autoplay blocked", "NotAllowedError"));

test("a remote tile starts audible: unmuted playback attempted on bind", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 99" />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay).toContain(false));
  expect(video.muted).toBe(false);
  expect(screen.queryByText(/audio blocked/i)).toBeNull();
});

test("the self tile stays muted and renders no audio controls", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="You" isSelf />);
  const video = container.querySelector("video")!;

  await waitFor(() => expect(mutedAtPlay.length).toBeGreaterThan(0));
  expect(video.muted).toBe(true);
  expect(mutedAtPlay).not.toContain(false);
  expect(screen.queryByRole("button")).toBeNull();
});

test("blocked autoplay falls back to muted playback + Restore Audio treatment", async () => {
  installPlay(blockUnmuted);
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 13" />);
  const video = container.querySelector("video")!;

  const restore = await screen.findByRole("button", { name: /restore audio/i });
  expect(screen.getByText(/audio blocked by browser/i)).toBeDefined();
  expect(video.muted).toBe(true); // the picture keeps rolling, silently

  installPlay(); // the user gesture now succeeds
  fireEvent.click(restore);
  await waitFor(() => expect(video.muted).toBe(false));
  expect(screen.queryByText(/audio blocked/i)).toBeNull();
});

test("mute silences one person locally; unmute restores them", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 99" />);
  const video = container.querySelector("video")!;
  await waitFor(() => expect(video.muted).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: /^mute$/i }));
  expect(video.muted).toBe(true);
  expect(video.className).toContain("saturate-"); // muted tile dims

  fireEvent.click(screen.getByRole("button", { name: /unmute/i }));
  await waitFor(() => expect(video.muted).toBe(false));
  expect(screen.getByRole("button", { name: /^mute$/i })).toBeDefined();
  expect(video.className).not.toContain("saturate-");
});

test("a replaced stream is a fresh join: mute resets to audible", async () => {
  const { container, rerender } = render(
    <VideoTile stream={fakeStream()} label="Agent 99" />,
  );
  const video = container.querySelector("video")!;
  await waitFor(() => expect(video.muted).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: /^mute$/i }));
  expect(video.muted).toBe(true);

  rerender(<VideoTile stream={fakeStream()} label="Agent 99" />);
  await waitFor(() => expect(video.muted).toBe(false));
  expect(screen.getByRole("button", { name: /^mute$/i })).toBeDefined();
});
