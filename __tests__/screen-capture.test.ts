// getScreenStream (lib/webrtc/media.ts): the getDisplayMedia wrapper. Unlike
// getUserMedia, a NotAllowedError here is the NORMAL outcome of the user
// closing the browser's picker — never an error card — so the whole API is
// "a stream, or null", no MediaError. Same navigator-stub idiom as
// media-constraints.test.ts.
import { beforeEach, expect, test, vi } from "vitest";
import { getScreenStream, screenShareSupported } from "@/lib/webrtc/media";

const getDisplayMedia = vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>();

const fakeStream = {} as MediaStream;

beforeEach(() => {
  vi.restoreAllMocks();
  getDisplayMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
});

// Screen audio is opt-in through the BROWSER's own picker checkbox ("Share
// tab audio" / "Share system audio"), so it is always requested and never a
// Cone toggle. The audio constraints keep the shared sound as-is (voice DSP
// mangles music/video) and keep the call itself out of it: our own tab is
// excluded from the picker and from system-audio capture, or every remote
// voice the sharer hears would be sent straight back to its owner.
test("requests video plus browser-opt-in audio, with the call's own audio kept out", async () => {
  getDisplayMedia.mockResolvedValue(fakeStream);

  const stream = await getScreenStream();

  expect(stream).toBe(fakeStream);
  expect(getDisplayMedia).toHaveBeenCalledOnce();
  const opts = getDisplayMedia.mock.calls[0][0] as Record<string, unknown>;
  expect(opts.video).toBe(true);
  expect(opts.systemAudio).toBe("include");
  expect(opts.selfBrowserSurface).toBe("exclude");
  expect(opts.audio).toEqual({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    suppressLocalAudioPlayback: false,
    restrictOwnAudio: true,
  });
});

test("a cancelled picker (NotAllowedError) is null, not a throw", async () => {
  getDisplayMedia.mockRejectedValue(new DOMException("dismissed", "NotAllowedError"));

  await expect(getScreenStream()).resolves.toBeNull();
});

test("any other capture failure is also null (logged, never thrown)", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  getDisplayMedia.mockRejectedValue(new DOMException("busy", "NotReadableError"));

  await expect(getScreenStream()).resolves.toBeNull();
  expect(errorSpy).toHaveBeenCalled();
});

test("a platform without getDisplayMedia is unsupported and resolves null", async () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });

  expect(screenShareSupported()).toBe(false);
  await expect(getScreenStream()).resolves.toBeNull();
});

test("a platform with getDisplayMedia is supported", () => {
  expect(screenShareSupported()).toBe(true);
});
