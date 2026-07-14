// Trusted-tier HTTP API (admin CRUD + token verify). Inlined at build time.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
// Signaling WebSocket (same server process). Standing rule: always env-driven,
// never hardcoded, so any host can swap it without code changes.
export const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL ?? "ws://localhost:8787/ws";
