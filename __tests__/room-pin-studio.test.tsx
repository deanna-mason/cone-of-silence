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

// The clipboard-copy-fail test below needs to reach the "in-room" stage,
// which the real useCallSession hook would drive over an actual WebSocket
// (jsdom has none) — stub it to a steady "connected" state with no peers,
// mirroring the shape hooks/useCallSession.ts's CallState actually returns.
// Harmless to the other tests in this file: neither reaches "in-room" (both
// stop in the green room), so nothing here observes call.status/peers/bus.
vi.mock("@/hooks/useCallSession", () => ({
  useCallSession: () => ({
    status: "connected",
    peers: [],
    dcOpen: false,
    bus: {
      sendAll: () => {},
      sendTo: () => false,
      onMessage: () => () => {},
      xfer: {
        send: () => false,
        bufferedAmount: () => -1,
        onMessage: () => () => {},
        onDrain: () => () => {},
        onChannelState: () => () => {},
      },
    },
    xferKey: null,
  }),
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

test("a blocked clipboard in-call shows a visible copy-failed notice, not a silent no-op", async () => {
  const writeText = vi.fn(async () => {
    throw new DOMException("write blocked", "NotAllowedError");
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

  render(<RoomPage />);
  const enter = await screen.findByRole("button", { name: /enter the cone/i });
  fireEvent.click(enter);

  const copyInvite = await screen.findByRole("button", { name: /copy invite/i });
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.click(copyInvite);
  await waitFor(() => expect(writeText).toHaveBeenCalled());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/copy the invite link manually/i);
});
