// Studio home (flow B): a logged-in host who has pinned a standing room sees an
// "Enter the Studio" card. Entering is a FULL page load (window.location.assign
// — the hash-navigation rule), never the client router.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import StudioPage from "@/app/studio/page";
import { buildInviteLink, type RoomKeys } from "@/lib/roomLink";

const ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const KEYS: RoomKeys = { roomId: ID, secret: SECRET };

// A logged-in session and a quiet library fetch so the page renders cleanly.
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

// vitest globals are off — auto-cleanup never registers; unmount explicitly.
afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({ recordings: [] }) }) as unknown as Response,
    ),
  );
});

test("session + pinned room → Enter the Studio card renders", async () => {
  seedSession();
  localStorage.setItem("cos-studio-room", JSON.stringify(KEYS));
  render(<StudioPage />);
  expect(await screen.findByRole("button", { name: /enter the studio/i })).toBeDefined();
});

test("session but no pinned room → no Enter the Studio card", async () => {
  seedSession();
  render(<StudioPage />);
  // The upload desk still renders, proving the page mounted.
  await screen.findByText(/upload for enhancement/i);
  expect(screen.queryByRole("button", { name: /enter the studio/i })).toBeNull();
});

test("Enter the Studio does a full-page load to the pinned room link", async () => {
  seedSession();
  localStorage.setItem("cos-studio-room", JSON.stringify(KEYS));
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, origin: "https://coneofsilence.app", assign },
  });

  render(<StudioPage />);
  const enter = await screen.findByRole("button", { name: /enter the studio/i });
  fireEvent.click(enter);

  expect(assign).toHaveBeenCalledWith(buildInviteLink(KEYS, "https://coneofsilence.app"));
});
