// Studio-home pin (flow B): the standing podcast room a logged-in host returns
// to. RoomKeys live in localStorage under `cos-studio-room`, TOKEN_RE-validated
// on read (garbage tolerated → null), mirroring lib/createToken.ts. The E2EE
// secret it carries never reaches any server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearStudioRoom,
  markConvened,
  parseInviteFragment,
  pinStudioRoom,
  readLastConvened,
  readStudioName,
  readStudioRoom,
  readStudioRoomSnapshot,
  setStudioName,
  subscribeStudioRoom,
} from "@/lib/studioRoom";
import type { RoomKeys } from "@/lib/roomLink";

const ID = "A".repeat(22); // 22 base64url chars
const SECRET = "B".repeat(22);
const KEYS: RoomKeys = { roomId: ID, secret: SECRET };

// A genuinely different room — used for the replace/reset semantics below.
const OTHER_ID = "C".repeat(22);
const OTHER_KEYS: RoomKeys = { roomId: OTHER_ID, secret: "D".repeat(22) };

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("pin/read round-trip", () => {
  it("reads back exactly what was pinned", () => {
    pinStudioRoom(KEYS);
    expect(readStudioRoom()).toEqual(KEYS);
  });

  it("clear removes the pin", () => {
    pinStudioRoom(KEYS);
    clearStudioRoom();
    expect(readStudioRoom()).toBeNull();
  });

  it("reads null when nothing is pinned", () => {
    expect(readStudioRoom()).toBeNull();
  });
});

describe("validation on pin", () => {
  it("refuses to pin a malformed roomId", () => {
    pinStudioRoom({ roomId: "too-short", secret: SECRET });
    expect(readStudioRoom()).toBeNull();
  });

  it("refuses to pin a malformed secret", () => {
    pinStudioRoom({ roomId: ID, secret: "not valid!!" });
    expect(readStudioRoom()).toBeNull();
  });
});

describe("garbage tolerance on read", () => {
  it("tolerates non-JSON", () => {
    localStorage.setItem("cos-studio-room", "{not json");
    expect(readStudioRoom()).toBeNull();
  });

  it("tolerates missing fields", () => {
    localStorage.setItem("cos-studio-room", JSON.stringify({ roomId: ID }));
    expect(readStudioRoom()).toBeNull();
  });

  it("tolerates a stored value that fails TOKEN_RE", () => {
    localStorage.setItem(
      "cos-studio-room",
      JSON.stringify({ roomId: "☠", secret: SECRET }),
    );
    expect(readStudioRoom()).toBeNull();
  });
});

describe("studio name", () => {
  it("round-trips an editable name", () => {
    setStudioName("Night Desk");
    expect(readStudioName()).toBe("Night Desk");
  });

  it("is null when unset", () => {
    expect(readStudioName()).toBeNull();
  });

  it("trims, and an all-whitespace name clears it", () => {
    setStudioName("  Cold Open  ");
    expect(readStudioName()).toBe("Cold Open");
    setStudioName("   ");
    expect(readStudioName()).toBeNull();
  });
});

describe("last convened", () => {
  it("is null before the studio is ever entered", () => {
    expect(readLastConvened()).toBeNull();
  });

  it("records a parseable timestamp when marked", () => {
    markConvened();
    const at = readLastConvened();
    expect(at).not.toBeNull();
    expect(Number.isNaN(Date.parse(at!))).toBe(false);
  });

  it("tolerates garbage", () => {
    localStorage.setItem("cos-studio-last-convened", "not-a-date");
    expect(readLastConvened()).toBeNull();
  });
});

// Defect 5 (2026-08-05 review): clearStudioRoom() has always cleared the name
// and last-convened stamp alongside the room, but pinStudioRoom() did not — so
// replacing your standing studio left the OLD studio's name and "Last convened"
// stamp attached to the NEW room. Fixed at the store so it holds for every
// caller (green room AND the account page's first-run invite path), not just
// whichever surface remembered to clean up.
describe("name and stamp follow the room", () => {
  it("pinning a DIFFERENT room clears the previous studio's name and stamp", () => {
    pinStudioRoom(KEYS);
    setStudioName("Night Desk");
    markConvened();

    pinStudioRoom(OTHER_KEYS);

    expect(readStudioRoom()).toEqual(OTHER_KEYS);
    expect(readStudioName()).toBeNull();
    expect(readLastConvened()).toBeNull();
  });

  it("re-pinning the SAME room preserves its name and stamp", () => {
    pinStudioRoom(KEYS);
    setStudioName("Night Desk");
    markConvened();

    pinStudioRoom(KEYS);

    expect(readStudioName()).toBe("Night Desk");
    expect(readLastConvened()).not.toBeNull();
  });

  it("re-pinning the same roomId with a re-keyed secret is the same studio, not a new one", () => {
    pinStudioRoom(KEYS);
    setStudioName("Night Desk");

    pinStudioRoom({ roomId: ID, secret: "E".repeat(22) });

    expect(readStudioName()).toBe("Night Desk");
  });

  it("a refused (malformed) pin never disturbs the existing studio", () => {
    pinStudioRoom(KEYS);
    setStudioName("Night Desk");

    pinStudioRoom({ roomId: "too-short", secret: SECRET });

    expect(readStudioRoom()).toEqual(KEYS);
    expect(readStudioName()).toBe("Night Desk");
  });
});

// The pin is read through useSyncExternalStore in both app/studio/page.tsx and
// the green room. Without a real subscription, a release performed in a child
// component never re-renders the parent that owns the read.
describe("room subscription", () => {
  it("notifies subscribers when a room is pinned", () => {
    let calls = 0;
    const unsubscribe = subscribeStudioRoom(() => calls++);

    pinStudioRoom(KEYS);

    expect(calls).toBe(1);
    unsubscribe();
  });

  it("notifies subscribers when the room is released", () => {
    pinStudioRoom(KEYS);
    let calls = 0;
    const unsubscribe = subscribeStudioRoom(() => calls++);

    clearStudioRoom();

    expect(calls).toBe(1);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeStudioRoom(() => calls++);
    unsubscribe();

    pinStudioRoom(KEYS);

    expect(calls).toBe(0);
  });

  it("snapshot returns the new value after a change and the SAME reference when nothing changed", () => {
    pinStudioRoom(KEYS);
    const first = readStudioRoomSnapshot();
    expect(first).toEqual(KEYS);
    // Referential stability is what useSyncExternalStore requires of
    // getSnapshot — a fresh parse every call would loop the render.
    expect(readStudioRoomSnapshot()).toBe(first);

    pinStudioRoom(OTHER_KEYS);
    const second = readStudioRoomSnapshot();
    expect(second).toEqual(OTHER_KEYS);
    expect(second).not.toBe(first);

    clearStudioRoom();
    expect(readStudioRoomSnapshot()).toBeNull();
  });
});

describe("parseInviteFragment", () => {
  it("parses a well-formed combined first-run invite", () => {
    const token = "T".repeat(22);
    expect(parseInviteFragment(`#invite=${token}&r=${ID}&s=${SECRET}`)).toEqual({
      signupToken: token,
      room: KEYS,
    });
  });

  it("tolerates a leading hash being absent", () => {
    const token = "T".repeat(22);
    expect(parseInviteFragment(`invite=${token}&r=${ID}&s=${SECRET}`)).toEqual({
      signupToken: token,
      room: KEYS,
    });
  });

  it("returns null when the room keys are malformed", () => {
    const token = "T".repeat(22);
    expect(parseInviteFragment(`#invite=${token}&r=short&s=${SECRET}`)).toBeNull();
  });

  it("returns null when the signup token is malformed", () => {
    expect(parseInviteFragment(`#invite=bad&r=${ID}&s=${SECRET}`)).toBeNull();
  });

  it("returns null for an unrelated fragment (e.g. a plain room hash)", () => {
    expect(parseInviteFragment(`#r=${ID}&s=${SECRET}`)).toBeNull();
  });
});
