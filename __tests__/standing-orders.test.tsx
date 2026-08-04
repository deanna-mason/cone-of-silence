// Studio Home "Standing Orders" card (Exhibit A). Self-contained component:
// studio name, line-status lamp, Enter the Studio (Initiate Contact idiom,
// full-page load), and Transfer of Custody device handoff (copyable invite link
// + a UI-only burn countdown — NOT a server-enforced one-time use).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import StandingOrders from "@/components/StandingOrders";
import { buildInviteLink, type RoomKeys } from "@/lib/roomLink";
import { readLastConvened, setStudioName } from "@/lib/studioRoom";

const ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const ROOM: RoomKeys = { roomId: ID, secret: SECRET };

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("shows a themed placeholder name when none is set", () => {
  render(<StandingOrders room={ROOM} />);
  expect(screen.getByText(/standing studio/i)).toBeDefined();
});

test("shows the custom studio name when one is set", () => {
  setStudioName("Night Desk");
  render(<StandingOrders room={ROOM} />);
  expect(screen.getByText(/night desk/i)).toBeDefined();
});

test("renders the line-status lamp and the Enter the Studio CTA", () => {
  render(<StandingOrders room={ROOM} />);
  expect(screen.getByText(/standing by/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /enter the studio/i })).toBeDefined();
});

test("Enter the Studio marks convened and does a full-page load to the room link", () => {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, origin: "https://coneofsilence.app", assign },
  });
  render(<StandingOrders room={ROOM} />);
  fireEvent.click(screen.getByRole("button", { name: /enter the studio/i }));
  expect(readLastConvened()).not.toBeNull();
  expect(assign).toHaveBeenCalledWith(buildInviteLink(ROOM, "https://coneofsilence.app"));
});

test("Transfer of Custody reveals a copyable invite link with a burn countdown", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, origin: "https://coneofsilence.app" },
  });

  render(<StandingOrders room={ROOM} />);
  // Default: a bordered handoff button, no code shown yet.
  const handoff = screen.getByRole("button", { name: /hand off to another device/i });
  expect(screen.queryByText(/burns in/i)).toBeNull();

  fireEvent.click(handoff);
  expect(await screen.findByText(/burns in/i)).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(buildInviteLink(ROOM, "https://coneofsilence.app")),
  );
});

test("a blocked clipboard swaps the button label to a visible failure state, not a silent no-op", async () => {
  const writeText = vi.fn(async () => {
    throw new DOMException("write permission denied", "NotAllowedError");
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, origin: "https://coneofsilence.app" },
  });

  render(<StandingOrders room={ROOM} />);
  fireEvent.click(screen.getByRole("button", { name: /hand off to another device/i }));
  await screen.findByText(/burns in/i);

  fireEvent.click(screen.getByRole("button", { name: /copy link/i }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());

  expect(await screen.findByRole("button", { name: /copy failed/i })).toBeDefined();
  expect(screen.queryByRole("button", { name: /^copy link$/i })).toBeNull();
});
