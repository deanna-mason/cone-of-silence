"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminApiError, listGrants, type Grant } from "@/lib/adminApi";

const SECRET_KEY = "cos-admin-secret"; // sessionStorage: dies with the tab

function readStashedSecret(): string {
  try {
    return sessionStorage.getItem(SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function AdminConsole() {
  const [secret, setSecret] = useState<string | null>(null); // null = locked
  const [pasted, setPasted] = useState("");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (activeSecret: string) => {
    setError(null);
    try {
      setGrants(await listGrants(activeSecret));
      setSecret(activeSecret);
      try {
        sessionStorage.setItem(SECRET_KEY, activeSecret);
      } catch {
        // session persistence is best-effort
      }
    } catch (err) {
      setSecret(null);
      setError(
        err instanceof AdminApiError && err.status === 401
          ? "✕ Access denied."
          : err instanceof AdminApiError && err.status === 429
            ? "✕ Too many attempts — wait a minute."
            : "✕ channel unavailable",
      );
    }
  }, []);

  useEffect(() => {
    const stashed = readStashedSecret();
    if (stashed) void refresh(stashed);
  }, [refresh]);

  if (secret === null) {
    return (
      <section className="hairline mx-auto max-w-lg border bg-inset p-6">
        <p className="kicker text-sienna">Restricted — Operator Access</p>
        <h1 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink">
          Credential Desk
        </h1>
        <label htmlFor="admin-secret" className="kicker mt-6 block text-ink-soft">
          Paste operator secret
        </label>
        <input
          id="admin-secret"
          type="password"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pasted) void refresh(pasted);
          }}
          className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink focus:border-brass focus:outline-none"
        />
        {error && (
          <p role="alert" className="kicker mt-3 text-vermilion">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => pasted && void refresh(pasted)}
          className="kicker mt-6 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Unlock
        </button>
      </section>
    );
  }

  return (
    <section className="hairline border bg-inset p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-sienna">Issued Credentials</p>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.removeItem(SECRET_KEY);
            } catch {
              // ignore
            }
            setSecret(null);
            setPasted("");
          }}
          className="kicker text-ink-soft transition hover:text-vermilion"
        >
          Lock Desk
        </button>
      </div>

      {error && (
        <p role="alert" className="kicker mt-3 text-vermilion">
          {error}
        </p>
      )}

      <table className="mt-6 w-full text-left font-type text-sm">
        <thead>
          <tr className="kicker text-ink-soft">
            <th className="pb-2">Label</th>
            <th className="pb-2">Issued</th>
            <th className="pb-2">Last Used</th>
            <th className="pb-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id} className="border-t border-ink-faint/20">
              <td className="py-2 text-ink">{g.label}</td>
              <td className="py-2 text-ink-soft">{new Date(g.createdAt).toLocaleDateString()}</td>
              <td className="py-2 text-ink-soft">
                {g.lastUsedAt ? new Date(g.lastUsedAt).toLocaleString() : "never"}
              </td>
              <td className="py-2">
                {g.revokedAt ? (
                  <span className="kicker text-vermilion">REVOKED</span>
                ) : (
                  <span className="kicker text-brass">ACTIVE</span>
                )}
              </td>
            </tr>
          ))}
          {grants.length === 0 && (
            <tr>
              <td colSpan={4} className="py-6 text-center font-body italic text-ink-soft">
                No credentials issued yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
