// FaceThumb — the tiny faces riding the fullscreen screen view. Strictly
// picture-only: the full tiles (with the call's live audio) keep playing
// underneath the fullscreen element, so an unmuted copy here would double
// every voice.
import { afterEach, beforeEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import FaceThumb from "@/components/FaceThumb";

afterEach(cleanup);

beforeEach(() => {
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
});

function fakeStream(): MediaStream {
  return {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
  } as unknown as MediaStream;
}

test("renders a muted picture with its label", () => {
  const { container } = render(<FaceThumb stream={fakeStream()} label="Agent 2" />);
  const video = container.querySelector("video")!;

  expect(video.muted).toBe(true);
  expect(screen.getByText("Agent 2")).toBeTruthy();
});

test("the self thumb mirrors like the self tile", () => {
  const { container } = render(<FaceThumb stream={fakeStream()} label="You" mirrored />);
  expect(container.querySelector("video")!.className).toContain("-scale-x-100");
});
