import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const BCRYPT_COST = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** 256-bit bearer session token; only its SHA-256 is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
