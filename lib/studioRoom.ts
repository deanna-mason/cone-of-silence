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

// localStorage fires no native event for a same-tab write, and BOTH
// app/studio/page.tsx and the green room read this store through
// useSyncExternalStore — so a release performed inside StandingOrders would
// never re-render the page that owns the read. Same tiny pub-sub idiom
// components/StandingOrders.tsx already uses for the studio name.
const roomSubscribers = new Set<() => void>();

export function subscribeStudioRoom(cb: () => void): () => void {
  roomSubscribers.add(cb);
  return () => {
    roomSubscribers.delete(cb);
  };
}

function notifyStudioRoomChange(): void {
  roomSubscribers.forEach((cb) => cb());
}

export function pinStudioRoom(keys: RoomKeys): void {
  if (!validKeys(keys)) return; // never pin garbage
  try {
    // The name and the last-convened stamp describe the room they were set
    // on. Replacing the studio with a DIFFERENT room must not leave the old
    // studio's name and timestamp attached to a room the host has never
    // entered (2026-08-05 defect 5 — "Night Desk · Last convened 03 Aug"
    // about a brand-new room). Re-pinning the SAME room keeps both, including
    // across a re-key, where roomId is stable and only the secret moves.
    // Done here rather than in any caller so it holds for the account page's
    // first-run invite path too.
    const previous = readStudioRoom();
    if (previous && previous.roomId !== keys.roomId) {
      localStorage.removeItem(NAME_KEY);
      localStorage.removeItem(CONVENED_KEY);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomId: keys.roomId, secret: keys.secret }));
  } catch {
    // storage unavailable — the pin just won't persist on this browser
  }
  // Fires even when the write above threw: subscribers then re-read and
  // honestly show "nothing pinned" instead of a phantom success.
  notifyStudioRoomChange();
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

// readStudioRoom() parses the stored JSON on every call, which would break
// the referential stability useSyncExternalStore requires of getSnapshot.
// This caches the parsed result keyed on the raw localStorage string, only
// re-parsing when that string changes. Used by app/studio/page.tsx (Task 4).
let cachedRawRoom: string | null = null;
let cachedRoomSnapshot: RoomKeys | null = null;

export function readStudioRoomSnapshot(): RoomKeys | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRawRoom) {
    cachedRawRoom = raw;
    cachedRoomSnapshot = readStudioRoom();
  }
  return cachedRoomSnapshot;
}

export function clearStudioRoom(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(CONVENED_KEY);
  } catch {
    // ignore
  }
  notifyStudioRoomChange();
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
