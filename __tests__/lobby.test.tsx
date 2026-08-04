// Lobby (app/page.tsx) — the 4A "Case-File Cover" redesign (design CS-DR-04).
// The lobby is the folder: a tabbed manila cover on the deeper paper tone with
// typed dossier rows (Subject / Retention / Clearance), a rotated CLASSIFIED
// cover stamp, and a one-gesture join flow. These tests pin the load-bearing
// wiring the redesign must NOT break: #create= token intake → localStorage
// `cos-create-token`, re-verify-on-visit, BURN CREDENTIALS, create-button
// gating (join is NEVER gated), and room entry as a FULL page load.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import LobbyPage from "@/app/page";

const TOKEN = "c".repeat(22); // base64url of 16 bytes — a valid create token
const ROOM_ID = "A".repeat(22);
const SECRET = "B".repeat(22);
const CREATE_STORAGE_KEY = "cos-create-token";

/** Point window.location at a hash, with a stub assign to catch full-page loads. */
function stubLocation(hash: string) {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      href: `https://coneofsilence.app/${hash}`,
      origin: "https://coneofsilence.app",
      pathname: "/",
      search: "",
      hash,
      assign,
    },
  });
  return assign;
}

function mockVerify(valid: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => ({ ok: true, status: 200, json: async () => ({ valid }) }) as unknown as Response,
    ),
  );
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  mockVerify(true);
  stubLocation("");
});

test("renders the Case-File Cover with a CLASSIFIED cover stamp and the typed dossier rows", () => {
  render(<LobbyPage />);
  expect(screen.getByText(/classified/i)).toBeDefined();
  expect(screen.getByText(/^subject$/i)).toBeDefined();
  expect(screen.getByText(/^retention$/i)).toBeDefined();
  expect(screen.getByText(/^clearance$/i)).toBeDefined();
  expect(screen.getByText(/burned on exit/i)).toBeDefined();
});

test("join is never gated — the paste line and Join button render with no clearance", () => {
  render(<LobbyPage />);
  expect(screen.getByPlaceholderText(/paste the invite link here/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /join/i })).toBeDefined();
  // With no credential on file, Initiate Contact is locked (not a button).
  expect(screen.queryByRole("button", { name: /initiate contact/i })).toBeNull();
});

test("#create= token intake stores the credential and unlocks Initiate Contact", async () => {
  stubLocation(`#create=${TOKEN}`);
  render(<LobbyPage />);
  await waitFor(() => {
    expect(localStorage.getItem(CREATE_STORAGE_KEY)).toBe(TOKEN);
    expect(screen.getByRole("button", { name: /initiate contact/i })).toBeDefined();
  });
});

test("re-verifies a stored token on visit and burns it locally when the server says inactive", async () => {
  localStorage.setItem(CREATE_STORAGE_KEY, TOKEN);
  mockVerify(false); // server: token revoked
  render(<LobbyPage />);
  await waitFor(() => {
    expect(screen.getByText(/no longer active/i)).toBeDefined();
    expect(localStorage.getItem(CREATE_STORAGE_KEY)).toBeNull();
  });
});

test("BURN CREDENTIALS shreds the stored token locally and re-locks Initiate Contact", async () => {
  localStorage.setItem(CREATE_STORAGE_KEY, TOKEN);
  render(<LobbyPage />);
  await screen.findByRole("button", { name: /initiate contact/i });

  fireEvent.click(screen.getByRole("button", { name: /burn credentials/i }));
  fireEvent.click(screen.getByRole("button", { name: /confirm burn/i }));

  await waitFor(() => {
    expect(localStorage.getItem(CREATE_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole("button", { name: /initiate contact/i })).toBeNull();
  });
});

test("pasting a room invite link routes into the room with a full-page load", () => {
  const assign = stubLocation("");
  render(<LobbyPage />);
  const paste = screen.getByPlaceholderText(/paste the invite link here/i);
  fireEvent.change(paste, {
    target: { value: `https://coneofsilence.app/room#r=${ROOM_ID}&s=${SECRET}` },
  });
  fireEvent.click(screen.getByRole("button", { name: /join/i }));
  expect(assign).toHaveBeenCalledWith(`/room#r=${ROOM_ID}&s=${SECRET}`);
});

test("a paste that is not one of ours is rejected and does not navigate", () => {
  const assign = stubLocation("");
  render(<LobbyPage />);
  const paste = screen.getByPlaceholderText(/paste the invite link here/i);
  fireEvent.change(paste, { target: { value: "https://evil.example.com/room#r=x&s=y" } });
  fireEvent.click(screen.getByRole("button", { name: /join/i }));
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeDefined();
});

test("Initiate Contact opens a fresh channel via a full-page load when cleared", async () => {
  const assign = stubLocation(`#create=${TOKEN}`);
  render(<LobbyPage />);
  const create = await screen.findByRole("button", { name: /initiate contact/i });
  fireEvent.click(create);
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign.mock.calls[0][0]).toMatch(/^\/room#r=[A-Za-z0-9_-]{22}&s=[A-Za-z0-9_-]{22}$/);
});
