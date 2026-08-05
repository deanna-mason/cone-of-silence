// Green-room "Pin as my Studio" (flow B): a logged-in host in a room can pin it
// as their standing Studio room. Covers Deanna's existing account, which never
// went through the combined first-run invite.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import RoomPage from "@/app/room/page";
import {
  markConvened,
  pinStudioRoom,
  readLastConvened,
  readStudioName,
  readStudioRoom,
  setStudioName,
} from "@/lib/studioRoom";

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

const OTHER_ID = "C".repeat(22);
const OTHER_KEYS = { roomId: OTHER_ID, secret: "D".repeat(22) };

test("a logged-in host can pin the current room as their Studio", async () => {
  seedSession();
  render(<RoomPage />);
  const pin = await screen.findByRole("button", { name: /^make this my standing studio$/i });
  fireEvent.click(pin);
  await waitFor(() => expect(readStudioRoom()).toEqual({ roomId: ID, secret: SECRET }));
});

test("an anonymous guest never sees the pin action", async () => {
  render(<RoomPage />);
  await screen.findByText(/enter the cone/i);
  expect(screen.queryByRole("button", { name: /standing studio/i })).toBeNull();
});

// Defect 1 (2026-08-05, found live by Deanna): `studioPinned` was useState(false)
// and the file never imported readStudioRoom — so the control tracked "have I
// clicked this during this page load", not "is this room my studio". Walking
// into your OWN standing studio still offered to pin it.
test("entering the room that is ALREADY your studio shows a confirmation, not a pin offer", async () => {
  seedSession();
  pinStudioRoom({ roomId: ID, secret: SECRET });
  render(<RoomPage />);

  expect(await screen.findByText(/this is your standing studio/i)).toBeDefined();
  expect(screen.queryByRole("button", { name: /standing studio/i })).toBeNull();
});

test("pinning swaps the offer for the same confirmation, with a way to reach the studio", async () => {
  seedSession();
  render(<RoomPage />);

  fireEvent.click(await screen.findByRole("button", { name: /^make this my standing studio$/i }));

  expect(await screen.findByText(/this is your standing studio/i)).toBeDefined();
  expect(screen.getByRole("link", { name: /studio/i }).getAttribute("href")).toBe("/studio");
});

// Defect 4: pinStudioRoom is an unconditional setItem, and the stored secret is
// the ONLY way back into a standing room — so this was one silent click from
// losing the old one. Two-step, and it names what is at stake.
test("a DIFFERENT pinned studio makes the offer a replacement that must be confirmed", async () => {
  seedSession();
  pinStudioRoom(OTHER_KEYS);
  setStudioName("Night Desk");
  render(<RoomPage />);

  const replace = await screen.findByRole("button", { name: /standing studio instead/i });
  fireEvent.click(replace);

  // Armed only — the warning names the studio at risk and says why it matters,
  // and nothing is written yet.
  const warning = screen.getByText(/this replaces/i);
  expect(warning.textContent).toMatch(/night desk/i);
  expect(warning.textContent).toMatch(/only way back in/i);
  expect(readStudioRoom()).toEqual(OTHER_KEYS);
});

test("backing out of a replacement leaves the original studio untouched", async () => {
  seedSession();
  pinStudioRoom(OTHER_KEYS);
  setStudioName("Night Desk");
  render(<RoomPage />);

  fireEvent.click(await screen.findByRole("button", { name: /standing studio instead/i }));
  fireEvent.click(screen.getByRole("button", { name: /^keep /i }));

  expect(readStudioRoom()).toEqual(OTHER_KEYS);
  expect(readStudioName()).toBe("Night Desk");
});

test("confirming a replacement repins to this room and drops the old name and stamp", async () => {
  seedSession();
  pinStudioRoom(OTHER_KEYS);
  setStudioName("Night Desk");
  markConvened();
  render(<RoomPage />);

  fireEvent.click(await screen.findByRole("button", { name: /standing studio instead/i }));
  fireEvent.click(screen.getByRole("button", { name: /^replace it$/i }));

  await waitFor(() => expect(readStudioRoom()).toEqual({ roomId: ID, secret: SECRET }));
  expect(readStudioName()).toBeNull();
  expect(readLastConvened()).toBeNull();
});

// Deanna's question, 2026-08-05: "if I'm in the studio, the only way to leave is
// to burn and leave — does that screw up my pinned room?" It does not, and this
// pins that. `leave()` clears the per-visit sessionStorage stash
// (clearStashedRoomKeys); the pin lives in localStorage under a different key.
// The ONLY things that may drop a pin are the explicit release and a confirmed
// replacement.
test("Burn & Leave shreds the visit, not the studio — the pin survives", async () => {
  seedSession();
  pinStudioRoom({ roomId: ID, secret: SECRET });
  render(<RoomPage />);

  fireEvent.click(await screen.findByRole("button", { name: /enter the cone/i }));
  fireEvent.click(await screen.findByRole("button", { name: /burn & leave/i }));

  expect(readStudioRoom()).toEqual({ roomId: ID, secret: SECRET });
  expect(sessionStorage.getItem("cos-room")).toBeNull();
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
