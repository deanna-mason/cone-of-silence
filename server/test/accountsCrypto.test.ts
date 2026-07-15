import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashPassword,
  USERNAME_RE,
  verifyPassword,
} from "../src/accounts/crypto.js";

describe("accounts crypto", () => {
  it("hashes and verifies a password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("session tokens are 43-char base64url and unique", () => {
    const a = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(a);
  });

  it("username regex accepts and rejects correctly", () => {
    for (const good of ["deanna", "ab_1", "x".repeat(20)]) expect(USERNAME_RE.test(good)).toBe(true);
    for (const bad of ["ab", "Deanna", "has space", "x".repeat(21), "email@no"]) {
      expect(USERNAME_RE.test(bad)).toBe(false);
    }
  });
});
