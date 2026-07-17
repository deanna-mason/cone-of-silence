// Repro for the professor-reported retry flash: clicking "Retry Equipment
// Check" must not show the green room until getUserMedia actually resolves.
import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import RoomPage from "@/app/room/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const VALID_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url chars

const getUserMedia = vi.fn<() => Promise<MediaStream>>();

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  sessionStorage.setItem(
    "cos-room",
    JSON.stringify({ roomId: VALID_TOKEN, secret: VALID_TOKEN }),
  );
  getUserMedia.mockReset();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => []),
    },
  });
});

function denied(): Promise<MediaStream> {
  return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
}

class FakeMediaStream extends EventTarget {
  private tracks = [
    { kind: "audio", enabled: true, stop() {} },
    { kind: "video", enabled: true, stop() {} },
  ];
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getTracks() {
    return this.tracks;
  }
}

test("retry does not flash the green room while the equipment check is pending", async () => {
  getUserMedia.mockImplementationOnce(denied);
  render(<RoomPage />);
  const retry = await screen.findByRole("button", { name: /retry equipment check/i });

  // Second attempt hangs (browser prompt open / slow grant) — never settles.
  getUserMedia.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(retry);

  await waitFor(() =>
    expect(screen.getByText(/running equipment check/i)).toBeDefined(),
  );
  expect(screen.queryByText(/enter the cone/i)).toBeNull();
});

test("retry that is denied again lands back on the error card, never the green room", async () => {
  getUserMedia.mockImplementation(denied);
  render(<RoomPage />);
  const retry = await screen.findByRole("button", { name: /retry equipment check/i });

  fireEvent.click(retry);

  await waitFor(() =>
    expect(screen.getByRole("button", { name: /retry equipment check/i })).toBeDefined(),
  );
  expect(screen.queryByText(/enter the cone/i)).toBeNull();
});

test("retry that succeeds reaches the green room", async () => {
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  getUserMedia.mockImplementationOnce(denied);
  render(<RoomPage />);
  const retry = await screen.findByRole("button", { name: /retry equipment check/i });

  getUserMedia.mockImplementation(async () => new FakeMediaStream() as unknown as MediaStream);
  fireEvent.click(retry);

  await waitFor(() => expect(screen.getByText(/enter the cone/i)).toBeDefined());
});
