// lib/studioRoom.ts
// A "pinned" Studio room: the standing podcast room a logged-in host returns to
// from Studio home (flow B). RoomKeys live in localStorage — convenience, never
// authority (the server still gates room creation). The E2EE secret it carries
// NEVER reaches any server: it stays in the fragment/localStorage only, exactly
// like the URL-fragment secret in lib/roomLink.ts. Mirrors lib/createToken.ts.

import { TOKEN_RE, type RoomKeys } from "./roomLink";

const STORAGE_KEY = "cos-studio-room";

function validKeys(keys: Partial<RoomKeys>): keys is RoomKeys {
  return (
    typeof keys.roomId === "string" &&
    typeof keys.secret === "string" &&
    TOKEN_RE.test(keys.roomId) &&
    TOKEN_RE.test(keys.secret)
  );
}

export function pinStudioRoom(keys: RoomKeys): void {
  if (!validKeys(keys)) return; // never pin garbage
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomId: keys.roomId, secret: keys.secret }));
  } catch {
    // storage unavailable — the pin just won't persist on this browser
  }
}

export function readStudioRoom(): RoomKeys | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const val = JSON.parse(raw) as Partial<RoomKeys>;
    return validKeys(val) ? { roomId: val.roomId, secret: val.secret } : null;
  } catch {
    return null;
  }
}

export function clearStudioRoom(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(CONVENED_KEY);
  } catch {
    // ignore
  }
}

const NAME_KEY = "cos-studio-name";
const CONVENED_KEY = "cos-studio-last-convened";
const NAME_MAX = 60;

/** An editable, human name for the standing studio (e.g. "Night Desk"). An
 *  all-whitespace name clears it — the card falls back to a themed placeholder. */
export function setStudioName(name: string): void {
  try {
    const trimmed = name.trim().slice(0, NAME_MAX);
    if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // storage unavailable — name just won't persist
  }
}

export function readStudioName(): string | null {
  try {
    const name = localStorage.getItem(NAME_KEY);
    return name && name.trim() ? name : null;
  } catch {
    return null;
  }
}

/** Stamps "now" as the last time the host walked into the standing room. */
export function markConvened(): void {
  try {
    localStorage.setItem(CONVENED_KEY, new Date().toISOString());
  } catch {
    // ignore
  }
}

export function readLastConvened(): string | null {
  try {
    const raw = localStorage.getItem(CONVENED_KEY);
    if (!raw || Number.isNaN(Date.parse(raw))) return null;
    return raw;
  } catch {
    return null;
  }
}

export interface InviteFragment {
  signupToken: string;
  room: RoomKeys;
}

/** Parses the combined first-run invite fragment `#invite=<token>&r=<id>&s=<secret>`.
 *  Returns null unless the signup token AND both room keys are well-formed. */
export function parseInviteFragment(hash: string): InviteFragment | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const signupToken = params.get("invite") ?? "";
  const roomId = params.get("r") ?? "";
  const secret = params.get("s") ?? "";
  if (!TOKEN_RE.test(signupToken) || !TOKEN_RE.test(roomId) || !TOKEN_RE.test(secret)) {
    return null;
  }
  return { signupToken, room: { roomId, secret } };
}
