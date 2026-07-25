import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_TTL_SECONDS,
  STUN_SERVERS,
  iceServers,
  mintTurnCredentials,
  turnConfigFromEnv,
} from "../src/turn/creds.js";

const CFG = { secret: "sssh", urls: ["turn:turn.example.com:3478?transport=udp"], ttlSeconds: 600 };
const NOW_MS = 1_753_000_000_000; // fixed clock — tests never read Date.now()

describe("mintTurnCredentials", () => {
  it("username is the unix expiry (now + ttl, seconds)", () => {
    const { username } = mintTurnCredentials(CFG, NOW_MS);
    expect(username).toBe(String(Math.floor(NOW_MS / 1000) + 600));
  });

  it("credential is base64 HMAC-SHA1(secret, username) — coturn REST format", () => {
    const { username, credential } = mintTurnCredentials(CFG, NOW_MS);
    const expected = createHmac("sha1", "sssh").update(username).digest("base64");
    expect(credential).toBe(expected);
  });
});

describe("iceServers", () => {
  it("returns STUN only when TURN is not configured", () => {
    expect(iceServers(null, NOW_MS)).toEqual(STUN_SERVERS);
  });

  it("appends a credentialed TURN entry after STUN when configured", () => {
    const list = iceServers(CFG, NOW_MS);
    expect(list[0]).toEqual(STUN_SERVERS[0]);
    expect(list[1]).toMatchObject({ urls: CFG.urls });
    expect(typeof list[1]!.username).toBe("string");
    expect(typeof list[1]!.credential).toBe("string");
  });
});

describe("turnConfigFromEnv", () => {
  it("returns null when neither var is set (dev default)", () => {
    expect(turnConfigFromEnv({})).toBeNull();
  });

  it("parses secret + comma-separated urls with default TTL", () => {
    const cfg = turnConfigFromEnv({
      TURN_SECRET: "s",
      TURN_URLS: "turn:a:3478?transport=udp, turn:a:3478?transport=tcp",
    });
    expect(cfg).toEqual({
      secret: "s",
      urls: ["turn:a:3478?transport=udp", "turn:a:3478?transport=tcp"],
      ttlSeconds: DEFAULT_TURN_TTL_SECONDS,
    });
  });

  it("honors TURN_TTL_SECONDS", () => {
    const cfg = turnConfigFromEnv({ TURN_SECRET: "s", TURN_URLS: "turn:a", TURN_TTL_SECONDS: "60" });
    expect(cfg?.ttlSeconds).toBe(60);
  });

  it("throws on partial config — a deploy mistake must fail loudly", () => {
    expect(() => turnConfigFromEnv({ TURN_SECRET: "s" })).toThrow();
    expect(() => turnConfigFromEnv({ TURN_URLS: "turn:a" })).toThrow();
    expect(() => turnConfigFromEnv({ TURN_SECRET: "s", TURN_URLS: "turn:a", TURN_TTL_SECONDS: "no" })).toThrow();
  });
});
