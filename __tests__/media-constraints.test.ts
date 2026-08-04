// Episodes are YouTube-bound: capture must request 1080p30 as *ideal* (never
// exact — ideal degrades gracefully on weak devices instead of hard-failing).
// Capture resolution drives recorder quality; call encodes self-adapt.
import { beforeEach, expect, test, vi } from "vitest";
import { getLocalStream } from "@/lib/webrtc/media";

const getUserMedia = vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>();

const fakeStream = {} as MediaStream;

const IDEAL_QUALITY = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};

beforeEach(() => {
  vi.restoreAllMocks();
  getUserMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

test("default acquisition requests ideal 1080p30 video", async () => {
  getUserMedia.mockResolvedValue(fakeStream);

  await getLocalStream();

  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(getUserMedia.mock.calls[0][0].video).toMatchObject(IDEAL_QUALITY);
});

test("an explicit camera choice keeps the exact deviceId and adds ideal quality", async () => {
  getUserMedia.mockResolvedValue(fakeStream);

  await getLocalStream({ videoDeviceId: "cam-1" });

  const video = getUserMedia.mock.calls[0][0].video as MediaTrackConstraints;
  expect(video).toMatchObject({ deviceId: { exact: "cam-1" }, ...IDEAL_QUALITY });
});

test("the default-device fallback after a missing chosen device still requests ideal quality", async () => {
  getUserMedia
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValue(fakeStream);

  await getLocalStream({ videoDeviceId: "unplugged-cam" });

  expect(getUserMedia).toHaveBeenCalledTimes(2);
  const fallbackVideo = getUserMedia.mock.calls[1][0].video as MediaTrackConstraints;
  expect(fallbackVideo).toMatchObject(IDEAL_QUALITY);
  expect(fallbackVideo).not.toHaveProperty("deviceId");
});

test("the mic-only fallback keeps video disabled", async () => {
  getUserMedia
    .mockRejectedValueOnce(new DOMException("no cam", "NotFoundError"))
    .mockResolvedValue(fakeStream);

  await getLocalStream();

  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(getUserMedia.mock.calls[1][0].video).toBe(false);
});

test("a facingMode choice requests it as ideal alongside ideal quality (phone flip)", async () => {
  getUserMedia.mockResolvedValue(fakeStream);

  await getLocalStream({ facingMode: "environment" });

  const video = getUserMedia.mock.calls[0][0].video as MediaTrackConstraints;
  expect(video).toMatchObject({ facingMode: { ideal: "environment" }, ...IDEAL_QUALITY });
  // ideal, never exact — a facing the device can't offer degrades, never hard-fails.
  expect(video).not.toHaveProperty("deviceId");
});

test("an explicit camera deviceId wins over facingMode (no conflicting constraints)", async () => {
  getUserMedia.mockResolvedValue(fakeStream);

  await getLocalStream({ videoDeviceId: "cam-1", facingMode: "user" });

  const video = getUserMedia.mock.calls[0][0].video as MediaTrackConstraints;
  expect(video).toMatchObject({ deviceId: { exact: "cam-1" }, ...IDEAL_QUALITY });
  expect(video).not.toHaveProperty("facingMode");
});
