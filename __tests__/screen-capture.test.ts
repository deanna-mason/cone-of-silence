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

test("requests video only — screen audio never enters the call's audio path", async () => {
  getDisplayMedia.mockResolvedValue(fakeStream);

  const stream = await getScreenStream();

  expect(stream).toBe(fakeStream);
  expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
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
