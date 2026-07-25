// TURN credential minting — coturn `use-auth-secret` REST format: the
// username is a unix expiry timestamp, the credential is
// base64(HMAC-SHA1(shared secret, username)). Minted per join reply, never
// exposed on an open HTTP endpoint. No TURN env → STUN-only (dev default).

import { createHmac } from "node:crypto";
import type { IceServer } from "../../../lib/webrtc/protocol.js";

export interface TurnConfig {
  secret: string;
  urls: string[];
  ttlSeconds: number;
}

export const DEFAULT_TURN_TTL_SECONDS = 43_200; // 12 h — outlives any sane call
export const STUN_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function mintTurnCredentials(
  cfg: TurnConfig,
  nowMs: number,
): { username: string; credential: string } {
  const username = String(Math.floor(nowMs / 1000) + cfg.ttlSeconds);
  const credential = createHmac("sha1", cfg.secret).update(username).digest("base64");
  return { username, credential };
}

export function iceServers(cfg: TurnConfig | null, nowMs: number): IceServer[] {
  if (!cfg) return STUN_SERVERS;
  const { username, credential } = mintTurnCredentials(cfg, nowMs);
  return [...STUN_SERVERS, { urls: cfg.urls, username, credential }];
}

/** Partial TURN config is a deploy mistake — throw so startup fails loudly. */
export function turnConfigFromEnv(env: NodeJS.ProcessEnv): TurnConfig | null {
  const secret = env.TURN_SECRET ?? "";
  const urls = (env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!secret && urls.length === 0) return null;
  if (!secret || urls.length === 0) {
    throw new Error("TURN_SECRET and TURN_URLS must be set together");
  }
  const ttlSeconds = env.TURN_TTL_SECONDS
    ? Number(env.TURN_TTL_SECONDS)
    : DEFAULT_TURN_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("TURN_TTL_SECONDS must be a positive number of seconds");
  }
  return { secret, urls, ttlSeconds };
}
