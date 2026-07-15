// lib/authApi.ts
// Thin client for invite-gated registration + login. The session token lives
// in localStorage only — never in a cookie.

import { API_URL } from "./config";

const SESSION_KEY = "cos-session";

export interface StoredSession {
  session: string;
  username: string;
  expiresAt: string;
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export function getSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.session || Date.parse(parsed.expiresAt) <= Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // best-effort
  }
}

function saveSession(session: StoredSession): StoredSession {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // persistence is best-effort — the caller still gets the session back
  }
  return session;
}

async function req<T>(path: string, init?: RequestInit, bearer?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
    });
  } catch {
    throw new AuthApiError(0, "channel unavailable");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AuthApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function signup(
  token: string,
  username: string,
  password: string,
): Promise<StoredSession> {
  const session = await req<StoredSession>("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ token, username, password }),
  });
  return saveSession(session);
}

export async function login(username: string, password: string): Promise<StoredSession> {
  const session = await req<StoredSession>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return saveSession(session);
}

export async function logout(): Promise<void> {
  const stored = getSession();
  if (stored) {
    await req<void>("/auth/logout", { method: "POST" }, stored.session).catch(() => {
      // best-effort — local session is cleared regardless
    });
  }
  clearSession();
}
