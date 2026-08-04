// Trusted-tier HTTP API (admin CRUD + token verify). Inlined at build time.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
// Signaling WebSocket (same server process). Standing rule: always env-driven,
// never hardcoded, so any host can swap it without code changes.
export const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL ?? "ws://localhost:8787/ws";
// STUN fallback for lib/webrtc/peer.ts's ICE_SERVERS — same standing rule:
// env-driven, never hardcoded, so a deployment can point at its own STUN
// server without a code change. Google's public STUN stays the default.
export const STUN_URL = process.env.NEXT_PUBLIC_STUN_URL ?? "stun:stun.l.google.com:19302";
