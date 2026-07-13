import { createHash, randomBytes } from "node:crypto";

/** 128-bit creation token, base64url (22 chars) — same shape as room IDs. */
export function generateToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Tokens are 128 random bits — a fast hash is sound; no key-stretching. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
