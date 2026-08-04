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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

// Poll-interval identity regression: the effect used to depend on `recordings`
// itself (a fresh array reference every fetch resolution, poll-triggered or
// not), so its cleanup+recreate cycle tore down and re-armed the 3s interval
// on every single tick. Depending on the derived `hasPending` boolean instead
// means the interval is armed exactly once for the whole pending window,
// which this test pins by counting setInterval calls, not just the poll's
// eventual effect.
test("the poll interval is armed once and stays armed while recordings remain pending", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  seedSession();
  const pendingRecording = {
    id: "r1",
    originalName: "field-tape.wav",
    sourceExt: "wav",
    status: "processing",
    error: null,
    createdAt: new Date().toISOString(),
  };
  const fetchMock = vi.fn(
    async () =>
      ({ ok: true, status: 200, json: async () => ({ recordings: [{ ...pendingRecording }] }) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

  render(<StudioPage />);
  // Flush the initial listRecordings() fetch chain — several real Promise
  // hops (fetch -> res.json() -> .then(setRecordings)) independent of the
  // faked clock, so this loops a few small advances rather than trusting one.
  // (screen.findByText's own internal waitFor polls via the now-faked
  // setInterval/setTimeout, which never fire without an explicit advance —
  // so a plain findByText here would hang instead of retrying.)
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(screen.getByText(/developing/i)).toBeDefined(); // proves the pending recording rendered

  expect(setIntervalSpy).toHaveBeenCalledTimes(1);

  // Three poll ticks, each resolving a fresh `recordings` array via
  // setRecordings — the exact state change that used to reset the interval.
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(3000);

  expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // the poll actually fired
  expect(setIntervalSpy).toHaveBeenCalledTimes(1); // still just the one interval
});
