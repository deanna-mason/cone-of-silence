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

export type ClientMessage =
  | { v: 1; t: "create"; roomId: string; token: string }
  | { v: 1; t: "join"; roomId: string }
  | { v: 1; t: "relay"; to: string; payload: string }
  | { v: 1; t: "leave" };

export type ErrorReason = "room-not-found" | "room-full" | "create-refused" | "bad-message";

export type ServerMessage =
  | { v: 1; t: "created"; selfId: string }
  | { v: 1; t: "joined"; selfId: string; peers: PeerInfo[] }
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

export function parseServerMessage(raw: string): ServerMessage | null {
  const m = parseEnvelope(raw);
  if (!m) return null;
  switch (m.t) {
    case "created":
      return typeof m.selfId === "string" ? { v: 1, t: "created", selfId: m.selfId } : null;
    case "joined": {
      if (typeof m.selfId !== "string" || !Array.isArray(m.peers)) return null;
      const peers: PeerInfo[] = [];
      for (const p of m.peers) {
        const peerId = (p as Record<string, unknown>)?.peerId;
        if (typeof peerId !== "string") return null;
        peers.push({ peerId });
      }
      return { v: 1, t: "joined", selfId: m.selfId, peers };
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
