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
  setStudioName,
} from "@/lib/studioRoom";
import type { RoomKeys } from "@/lib/roomLink";

const ID = "A".repeat(22); // 22 base64url chars
const SECRET = "B".repeat(22);
const KEYS: RoomKeys = { roomId: ID, secret: SECRET };

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
