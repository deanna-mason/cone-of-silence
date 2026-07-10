// lib/roomLink.ts
// Room identity: 128-bit random IDs/secrets, carried in the URL fragment
// (#r=<id>&s=<secret>) so they never reach any server, stashed per-tab.

const ROOM_PATH = "/room";
const STASH_KEY = "cos-room";
const TOKEN_BYTES = 16; // 128 bits
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // base64url of 16 bytes, no padding

export interface RoomKeys {
  roomId: string;
  secret: string;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function createRoomKeys(): RoomKeys {
  return { roomId: randomToken(), secret: randomToken() };
}

export function buildRoomHash({ roomId, secret }: RoomKeys): string {
  return `#r=${roomId}&s=${secret}`;
}

export function buildInviteLink(keys: RoomKeys, origin: string): string {
  return `${origin}${ROOM_PATH}${buildRoomHash(keys)}`;
}

export function parseRoomHash(hash: string): RoomKeys | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const roomId = params.get("r") ?? "";
  const secret = params.get("s") ?? "";
  if (!TOKEN_RE.test(roomId) || !TOKEN_RE.test(secret)) return null;
  return { roomId, secret };
}

/** Accepts a full pasted invite URL; returns keys only if it is one of ours. */
export function parseInviteLink(pasted: string): RoomKeys | null {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/$/, "") !== ROOM_PATH) return null;
  return parseRoomHash(url.hash);
}

export function stashRoomKeys(keys: RoomKeys): void {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify(keys));
  } catch {
    // storage unavailable (rare) — refresh-rejoin just won't work this tab
  }
}

export function readStashedRoomKeys(): RoomKeys | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const val = JSON.parse(raw) as Partial<RoomKeys>;
    if (typeof val.roomId !== "string" || typeof val.secret !== "string") return null;
    if (!TOKEN_RE.test(val.roomId) || !TOKEN_RE.test(val.secret)) return null;
    return { roomId: val.roomId, secret: val.secret };
  } catch {
    return null;
  }
}

export function clearStashedRoomKeys(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    // ignore
  }
}
