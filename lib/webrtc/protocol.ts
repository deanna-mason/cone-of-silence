// lib/webrtc/protocol.ts
// Wire protocol for the signaling channel — shared verbatim by the frontend
// and the server (which imports this file by relative path). React-free,
// DOM-free, dependency-free: types + validation only. Relay payloads are
// opaque strings end to end — the server never parses SDP.

export const PROTOCOL_VERSION = 1;
export const MAX_RELAY_PAYLOAD_CHARS = 64 * 1024;

const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/; // matches lib/roomLink.ts
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // matches lib/createToken.ts
const PEER_ID_RE = /^[A-Za-z0-9_-]{8}$/;
// generous headroom over the payload cap for the JSON envelope itself
const MAX_RAW_CHARS = MAX_RELAY_PAYLOAD_CHARS + 2048;

export interface PeerInfo {
  peerId: string;
}

/** Structural twin of the DOM's RTCIceServer — this file stays DOM-free. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ClientMessage =
  | { v: 1; t: "create"; roomId: string; token: string }
  | { v: 1; t: "join"; roomId: string }
  | { v: 1; t: "relay"; to: string; payload: string }
  | { v: 1; t: "leave" };

export type ErrorReason = "room-not-found" | "room-full" | "create-refused" | "bad-message";

export type ServerMessage =
  | { v: 1; t: "created"; selfId: string; ice?: IceServer[] }
  | { v: 1; t: "joined"; selfId: string; peers: PeerInfo[]; ice?: IceServer[] }
  | { v: 1; t: "peer-joined"; peerId: string }
  | { v: 1; t: "peer-left"; peerId: string }
  | { v: 1; t: "relay"; from: string; payload: string }
  | { v: 1; t: "error"; reason: ErrorReason; message: string };

const ERROR_REASONS: readonly string[] = ["room-not-found", "room-full", "create-refused", "bad-message"];

function parseEnvelope(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_RAW_CHARS) return null;
  let val: unknown;
  try {
    val = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof val !== "object" || val === null || Array.isArray(val)) return null;
  const rec = val as Record<string, unknown>;
  return rec.v === PROTOCOL_VERSION ? rec : null;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const m = parseEnvelope(raw);
  if (!m) return null;
  switch (m.t) {
    case "create":
      return typeof m.roomId === "string" && ROOM_ID_RE.test(m.roomId) &&
        typeof m.token === "string" && TOKEN_RE.test(m.token)
        ? { v: 1, t: "create", roomId: m.roomId, token: m.token }
        : null;
    case "join":
      return typeof m.roomId === "string" && ROOM_ID_RE.test(m.roomId)
        ? { v: 1, t: "join", roomId: m.roomId }
        : null;
    case "relay":
      return typeof m.to === "string" && PEER_ID_RE.test(m.to) &&
        typeof m.payload === "string" && m.payload.length <= MAX_RELAY_PAYLOAD_CHARS
        ? { v: 1, t: "relay", to: m.to, payload: m.payload }
        : null;
    case "leave":
      return { v: 1, t: "leave" };
    default:
      return null;
  }
}

function parseIceServers(val: unknown): IceServer[] | null | undefined {
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) return null;
  const out: IceServer[] = [];
  for (const item of val) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const urls = rec.urls;
    const urlsOk =
      typeof urls === "string" ||
      (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === "string"));
    if (!urlsOk) return null;
    if (rec.username !== undefined && typeof rec.username !== "string") return null;
    if (rec.credential !== undefined && typeof rec.credential !== "string") return null;
    const entry: IceServer = { urls: urls as string | string[] };
    if (rec.username !== undefined) entry.username = rec.username;
    if (rec.credential !== undefined) entry.credential = rec.credential;
    out.push(entry);
  }
  return out;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseEnvelope(raw);
  if (!m) return null;
  switch (m.t) {
    case "created": {
      if (typeof m.selfId !== "string") return null;
      const ice = parseIceServers(m.ice);
      if (ice === null) return null;
      return ice
        ? { v: 1, t: "created", selfId: m.selfId, ice }
        : { v: 1, t: "created", selfId: m.selfId };
    }
    case "joined": {
      if (typeof m.selfId !== "string" || !Array.isArray(m.peers)) return null;
      const peers: PeerInfo[] = [];
      for (const p of m.peers) {
        const peerId = (p as Record<string, unknown>)?.peerId;
        if (typeof peerId !== "string") return null;
        peers.push({ peerId });
      }
      const ice = parseIceServers(m.ice);
      if (ice === null) return null;
      return ice
        ? { v: 1, t: "joined", selfId: m.selfId, peers, ice }
        : { v: 1, t: "joined", selfId: m.selfId, peers };
    }
    case "peer-joined":
      return typeof m.peerId === "string" ? { v: 1, t: "peer-joined", peerId: m.peerId } : null;
    case "peer-left":
      return typeof m.peerId === "string" ? { v: 1, t: "peer-left", peerId: m.peerId } : null;
    case "relay":
      return typeof m.from === "string" && typeof m.payload === "string"
        ? { v: 1, t: "relay", from: m.from, payload: m.payload }
        : null;
    case "error":
      return typeof m.reason === "string" && ERROR_REASONS.includes(m.reason) &&
        typeof m.message === "string"
        ? { v: 1, t: "error", reason: m.reason as ErrorReason, message: m.message }
        : null;
    default:
      return null;
  }
}
