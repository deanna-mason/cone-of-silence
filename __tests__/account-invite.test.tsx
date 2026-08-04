// Combined first-run invite (flow B): a `#invite=<token>&r=<id>&s=<secret>`
// fragment prefills the signup token, is scrubbed from the URL bar
// (history.replaceState — the secret never lingers in history), and on a
// successful signup the room is pinned as the host's Studio.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

const { signup } = vi.hoisted(() => ({ signup: vi.fn() }));
vi.mock("@/lib/authApi", () => ({
  getSession: () => null,
  login: vi.fn(),
  logout: vi.fn(),
  signup,
  AuthApiError: class AuthApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import AccountPage from "@/app/account/page";
import { readStudioRoom } from "@/lib/studioRoom";
import { buildInviteLink } from "@/lib/roomLink";

const TOKEN = "T".repeat(22);
const ID = "A".repeat(22);
const SECRET = "B".repeat(22);

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  signup.mockReset();
  window.history.replaceState(null, "", `/account#invite=${TOKEN}&r=${ID}&s=${SECRET}`);
});

test("a combined invite fragment opens the Seal Broken screen and scrubs the fragment", async () => {
  render(<AccountPage />);
  expect(await screen.findByText(/you.?ve been issued a studio/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /claim your studio/i })).toBeDefined();
  // The token is carried by the link, never shown as a field to fill.
  expect(screen.queryByLabelText(/invitation token/i)).toBeNull();
  await waitFor(() => expect(window.location.hash).toBe(""));
});

test("Claim your Studio registers, pins the room, and lands the host in the room", async () => {
  signup.mockResolvedValue({
    session: "s".repeat(43),
    username: "nightjar",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      origin: "https://coneofsilence.app",
      pathname: "/account",
      hash: `#invite=${TOKEN}&r=${ID}&s=${SECRET}`,
      assign,
    },
  });

  render(<AccountPage />);
  await screen.findByRole("button", { name: /claim your studio/i });

  fireEvent.change(screen.getByLabelText(/codename/i), { target: { value: "nightjar" } });
  fireEvent.change(screen.getByLabelText(/passphrase/i), { target: { value: "correct horse" } });
  fireEvent.click(screen.getByRole("button", { name: /claim your studio/i }));

  await waitFor(() => expect(readStudioRoom()).toEqual({ roomId: ID, secret: SECRET }));
  expect(signup).toHaveBeenCalledWith(TOKEN, "nightjar", "correct horse");
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith(
      buildInviteLink({ roomId: ID, secret: SECRET }, "https://coneofsilence.app"),
    ),
  );
});
