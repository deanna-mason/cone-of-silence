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
  constructor(
    public track = new FakeTrack(),
    public audio: FakeTrack | null = null,
  ) {}
  getTracks() {
    return this.audio ? [this.track, this.audio] : [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return this.audio ? [this.audio] : [];
  }
}

function audioTrack() {
  const t = new FakeTrack();
  t.kind = "audio";
  return t;
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

// The sharer's "no audio shared" note keys off this: the browser decides
// (picker checkbox, platform support), so the only truth is the capture.
test("audioShared reports whether the capture came back with an audio track", async () => {
  const silent = new FakeScreenStream();
  getDisplayMedia.mockResolvedValue(silent as unknown as MediaStream);
  const view = mount();
  expect(view.result.current.audioShared).toBe(false); // nothing live yet

  await act(async () => view.result.current.start());
  expect(view.result.current.audioShared).toBe(false);

  act(() => view.result.current.stop());
  getDisplayMedia.mockResolvedValue(new FakeScreenStream(new FakeTrack(), audioTrack()) as unknown as MediaStream);
  await act(async () => view.result.current.start());
  expect(view.result.current.audioShared).toBe(true);
});

test("stop ends the screen AUDIO track too, not just the picture", async () => {
  const fake = new FakeScreenStream(new FakeTrack(), audioTrack());
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();
  await act(async () => view.result.current.start());

  act(() => view.result.current.stop());

  expect(fake.audio!.stop).toHaveBeenCalled();
  expect(view.result.current.audioShared).toBe(false);
});

test("the browser's Stop-sharing bar ends the audio track as well", async () => {
  const fake = new FakeScreenStream(new FakeTrack(), audioTrack());
  getDisplayMedia.mockResolvedValue(fake as unknown as MediaStream);
  const view = mount();
  await act(async () => view.result.current.start());

  act(() => {
    fake.track.dispatchEvent(new Event("ended"));
  });

  expect(fake.audio!.stop).toHaveBeenCalled();
  expect(screenPort.stop).toHaveBeenCalled();
});

test("supported mirrors getDisplayMedia's presence", () => {
  expect(mount().result.current.supported).toBe(true);
  cleanup();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
  expect(mount().result.current.supported).toBe(false);
});
