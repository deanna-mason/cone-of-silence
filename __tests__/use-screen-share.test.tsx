// useScreenShare — the capture half of screen sharing. Owns the
// getDisplayMedia lifecycle the way useLocalMedia owns getUserMedia: the
// session never stops tracks, this hook never negotiates. The browser's own
// floating "Stop sharing" bar ends the track WITHOUT any click in our UI —
// the `ended` listener is what keeps the far side's tile and our announce
// honest in that case.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useScreenShare } from "@/hooks/useScreenShare";

class FakeTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  stop = vi.fn();
}

class FakeScreenStream {
  id = "scr-fake";
  constructor(public track = new FakeTrack()) {}
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

const getDisplayMedia = vi.fn<() => Promise<MediaStream>>();
const screenPort = { share: vi.fn(), stop: vi.fn() };

beforeEach(() => {
  getDisplayMedia.mockReset();
  screenPort.share.mockReset();
  screenPort.stop.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
});

afterEach(cleanup);

function mount(active = true) {
  return renderHook(({ on }) => useScreenShare(screenPort, on), {
    initialProps: { on: active },
  });
}

test("start acquires the screen and puts it on the table", async () => {
  const fake = new FakeScreenStream();
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();

  await act(async () => view.result.current.start());

  expect(view.result.current.sharing).toBe(true);
  expect(view.result.current.stream).toBe(fake);
  expect(screenPort.share).toHaveBeenCalledWith(fake);
});

test("a cancelled picker changes nothing", async () => {
  getDisplayMedia.mockRejectedValue(new DOMException("dismissed", "NotAllowedError"));
  const view = mount();

  await act(async () => view.result.current.start());

  expect(view.result.current.sharing).toBe(false);
  expect(screenPort.share).not.toHaveBeenCalled();
});

test("stop ends the capture and clears the table", async () => {
  const fake = new FakeScreenStream();
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();
  await act(async () => view.result.current.start());

  act(() => view.result.current.stop());

  expect(fake.track.stop).toHaveBeenCalled();
  expect(screenPort.stop).toHaveBeenCalled();
  expect(view.result.current.sharing).toBe(false);
  expect(view.result.current.stream).toBeNull();
});

test("the browser's own Stop-sharing bar (track 'ended') clears the table too", async () => {
  const fake = new FakeScreenStream();
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();
  await act(async () => view.result.current.start());

  act(() => {
    fake.track.dispatchEvent(new Event("ended"));
  });

  expect(screenPort.stop).toHaveBeenCalled();
  expect(view.result.current.sharing).toBe(false);
});

test("leaving the room (active → false) ends the capture", async () => {
  const fake = new FakeScreenStream();
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();
  await act(async () => view.result.current.start());

  view.rerender({ on: false });

  expect(fake.track.stop).toHaveBeenCalled();
  expect(screenPort.stop).toHaveBeenCalled();
  expect(view.result.current.sharing).toBe(false);
});

test("supported mirrors getDisplayMedia's presence", () => {
  expect(mount().result.current.supported).toBe(true);
  cleanup();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
  expect(mount().result.current.supported).toBe(false);
});
