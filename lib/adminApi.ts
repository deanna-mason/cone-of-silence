// lib/adminApi.ts
// Thin client for the trusted tier's admin CRUD. The admin secret lives in
// component state/sessionStorage only — never in a cookie, never in a URL.

import { API_URL } from "./config";

export interface Grant {
  id: string;
  label: string;
  kind: "room-creation" | "signup";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function req<T>(path: string, secret: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new AdminApiError(0, "channel unavailable");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AdminApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function listGrants(secret: string): Promise<Grant[]> {
  const { grants } = await req<{ grants: Grant[] }>("/admin/tokens", secret);
  return grants;
}

export async function mintGrant(
  secret: string,
  label: string,
  kind: "room-creation" | "signup" = "room-creation",
): Promise<{ token: string; grant: Grant }> {
  return req("/admin/tokens", secret, {
    method: "POST",
    body: JSON.stringify({ label, kind }),
  });
}

export async function patchGrant(
  secret: string,
  id: string,
  body: { label: string } | { revoked: boolean },
): Promise<Grant> {
  const { grant } = await req<{ grant: Grant }>(`/admin/tokens/${id}`, secret, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return grant;
}

export async function purgeGrant(secret: string, id: string): Promise<void> {
  await req<void>(`/admin/tokens/${id}`, secret, { method: "DELETE" });
}

export function buildCreateInviteLink(token: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/#create=${token}`;
}
