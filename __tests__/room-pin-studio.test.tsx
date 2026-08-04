// Green-room "Pin as my Studio" (flow B): a logged-in host in a room can pin it
// as their standing Studio room. Covers Deanna's existing account, which never
// went through the combined first-run invite.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import RoomPage from "@/app/room/page";
import { readStudioRoom } from "@/lib/studioRoom";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const getUserMedia = vi.fn<() => Promise<MediaStream>>();

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

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem("cos-room", JSON.stringify({ roomId: ID, secret: SECRET }));
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async () => new FakeMediaStream() as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });
});

function seedSession() {
  localStorage.setItem(
    "cos-session",
    JSON.stringify({
      session: "s".repeat(43),
      username: "deanna",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
}

test("a logged-in host can pin the current room as their Studio", async () => {
  seedSession();
  render(<RoomPage />);
  const pin = await screen.findByRole("button", { name: /pin as my studio/i });
  fireEvent.click(pin);
  await waitFor(() => expect(readStudioRoom()).toEqual({ roomId: ID, secret: SECRET }));
});

test("an anonymous guest never sees the pin action", async () => {
  render(<RoomPage />);
  await screen.findByText(/enter the cone/i);
  expect(screen.queryByRole("button", { name: /pin as my studio/i })).toBeNull();
});
