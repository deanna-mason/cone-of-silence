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

test("self tile with a cut mic shows a loud persistent badge + vermilion border", async () => {
  const { container, rerender } = render(
    <VideoTile stream={fakeStream()} label="You" isSelf micCut />,
  );
  const figure = container.querySelector("figure")!;
  expect(screen.getByText(/your mic is cut/i)).toBeDefined();
  expect(figure.className).toContain("ring-vermilion");

  // Live mic (micCut false): no badge, no vermilion border.
  rerender(<VideoTile stream={fakeStream()} label="You" isSelf />);
  expect(screen.queryByText(/your mic is cut/i)).toBeNull();
  expect(container.querySelector("figure")!.className).not.toContain("ring-vermilion");
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

// The Mute button names WHO it silences (8/5 a11y pass): with four tiles on
// screen every one of these buttons read as the same control to a screen
// reader, so the accessible name carries the tile's label.
test("mute silences one person locally; unmute restores them", async () => {
  const { container } = render(<VideoTile stream={fakeStream()} label="Agent 99" />);
  const video = container.querySelector("video")!;
  await waitFor(() => expect(video.muted).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "Mute Agent 99" }));
  expect(video.muted).toBe(true);
  expect(video.className).toContain("saturate-"); // muted tile dims

  fireEvent.click(screen.getByRole("button", { name: "Unmute Agent 99" }));
  await waitFor(() => expect(video.muted).toBe(false));
  expect(screen.getByRole("button", { name: "Mute Agent 99" })).toBeDefined();
  expect(video.className).not.toContain("saturate-");
});

test("two remote tiles expose two DIFFERENT mute controls, one per agent", async () => {
  render(
    <>
      <VideoTile stream={fakeStream()} label="Agent 2" />
      <VideoTile stream={fakeStream()} label="Agent 3" />
    </>,
  );
  expect(screen.getByRole("button", { name: "Mute Agent 2" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Mute Agent 3" })).toBeDefined();
});

test("a replaced stream is a fresh join: mute resets to audible", async () => {
  const { container, rerender } = render(
    <VideoTile stream={fakeStream()} label="Agent 99" />,
  );
  const video = container.querySelector("video")!;
  await waitFor(() => expect(video.muted).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "Mute Agent 99" }));
  expect(video.muted).toBe(true);

  rerender(<VideoTile stream={fakeStream()} label="Agent 99" />);
  await waitFor(() => expect(video.muted).toBe(false));
  expect(screen.getByRole("button", { name: "Mute Agent 99" })).toBeDefined();
});

test("a stale play() rejection from a swapped-out stream does not blockade the new one", async () => {
  // The first unmuted play() (bound to the original stream) hangs until we
  // reject it by hand, simulating the browser aborting it mid-flight because
  // a newer srcObject assignment superseded it.
  let unmutedCalls = 0;
  let rejectFirstUnmuted: ((err: unknown) => void) | undefined;
  installPlay((muted) => {
    if (muted) return Promise.resolve();
    unmutedCalls += 1;
    if (unmutedCalls === 1) {
      return new Promise<void>((_, reject) => {
        rejectFirstUnmuted = reject;
      });
    }
    return Promise.resolve();
  });

  const { container, rerender } = render(
    <VideoTile stream={fakeStream()} label="Agent 99" />,
  );
  const video = container.querySelector("video")!;

  await waitFor(() => expect(unmutedCalls).toBe(1));

  // A fresh stream binds before the old pending play() ever settles.
  rerender(<VideoTile stream={fakeStream()} label="Agent 99" />);
  await waitFor(() => expect(unmutedCalls).toBe(2));
  await waitFor(() => expect(video.muted).toBe(false));

  // Now the stale promise rejects with AbortError — it belongs to a binding
  // this element no longer owns.
  rejectFirstUnmuted!(new DOMException("interrupted", "AbortError"));
  await waitFor(() => expect(video.muted).toBe(false));

  expect(video.muted).toBe(false);
  expect(screen.queryByText(/audio blocked/i)).toBeNull();
});

test("a failed Restore Audio gesture leaves the tile blocked, with no corner Mute button", async () => {
  installPlay(blockUnmuted);
  render(<VideoTile stream={fakeStream()} label="Agent 13" />);

  const restore = await screen.findByRole("button", { name: /restore audio/i });
  expect(screen.queryByRole("button", { name: /^mute /i })).toBeNull();

  const container = screen.getByText(/agent 13/i).closest("figure")!;
  const video = container.querySelector("video")!;
  const callsBeforeRestore = mutedAtPlay.length;

  fireEvent.click(restore);
  // blockUnmuted is still installed, so the retried unmuted play() is
  // refused again — the tile should settle right back into "blocked".
  await waitFor(() => expect(mutedAtPlay.length).toBeGreaterThan(callsBeforeRestore));

  expect(screen.getByText(/audio blocked by browser/i)).toBeDefined();
  expect(video.muted).toBe(true);
  expect(screen.queryByRole("button", { name: /^mute /i })).toBeNull();
});
