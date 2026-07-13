import { describe, expect, it } from "vitest";
import { generateToken, hashToken } from "../src/tokens/crypto.js";

describe("token crypto", () => {
  it("generates 22-char base64url tokens", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("generates unique tokens", () => {
    const seen = new Set(Array.from({ length: 100 }, generateToken));
    expect(seen.size).toBe(100);
  });

  it("hashes deterministically to sha256 hex", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});
