// Media failures must leave the underlying DOMException in the console so a
// remote report ("it said Equipment Compromised") can be diagnosed later.
import { beforeEach, expect, test, vi } from "vitest";
import { getLocalStream, MediaError } from "@/lib/webrtc/media";

const getUserMedia = vi.fn<() => Promise<MediaStream>>();

beforeEach(() => {
  vi.restoreAllMocks();
  getUserMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
});

test("a failed acquisition logs the DOMException name and message", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  getUserMedia.mockRejectedValue(
    new DOMException("Permission denied by user agent", "NotAllowedError"),
  );

  await expect(getLocalStream()).rejects.toBeInstanceOf(MediaError);

  const logged = log.mock.calls.flat().map(String).join(" ");
  expect(logged).toContain("NotAllowedError");
  expect(logged).toContain("Permission denied by user agent");
});
