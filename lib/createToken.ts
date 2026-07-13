// lib/createToken.ts
// Creation-token clearance: arrives once via #create=<token>, then lives in
// localStorage (deliberately NOT sessionStorage — clearance outlives a call;
// only revocation or burning ends it). localStorage is convenience, never
// authority: the server re-verifies on every create.

import { API_URL } from "./config";

const STORAGE_KEY = "cos-create-token";
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function parseCreateHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("create") ?? "";
  return TOKEN_RE.test(token) ? token : null;
}

export function storeCreateToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // storage unavailable — clearance just won't persist on this browser
  }
}

export function readCreateToken(): string | null {
  try {
    const token = localStorage.getItem(STORAGE_KEY);
    return token && TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Local shred only: the grant survives server-side until Deanna revokes it. */
export function burnCreateToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export type TokenStatus = "accepted" | "inactive" | "unreachable";

export async function verifyCreateToken(token: string): Promise<TokenStatus> {
  try {
    const res = await fetch(`${API_URL}/tokens/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return "unreachable"; // includes 503 fail-closed
    const data = (await res.json()) as { valid: boolean };
    return data.valid ? "accepted" : "inactive";
  } catch {
    return "unreachable";
  }
}
