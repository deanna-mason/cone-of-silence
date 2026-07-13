"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AdminApiError,
  buildCreateInviteLink,
  listGrants,
  mintGrant,
  patchGrant,
  purgeGrant,
  type Grant,
} from "@/lib/adminApi";

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
  const [mintLabel, setMintLabel] = useState("");
  const [minted, setMinted] = useState<{ label: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setGrants(await listGrants(secret!));
    } catch (err) {
      setError(err instanceof AdminApiError ? `✕ ${err.message}` : "✕ channel unavailable");
    } finally {
      setBusy(false);
    }
  }

  function handleMint() {
    const label = mintLabel.trim();
    if (!label) return;
    void withBusy(async () => {
      const { token, grant } = await mintGrant(secret!, label);
      setMinted({ label: grant.label, link: buildCreateInviteLink(token, window.location.origin) });
      setCopied(false);
      setMintLabel("");
    });
  }

  function handleRelabel(id: string) {
    const label = editLabel.trim();
    if (!label) return;
    void withBusy(async () => {
      await patchGrant(secret!, id, { label });
      setEditingId(null);
    });
  }

  function handleSetRevoked(id: string, revoked: boolean) {
    setPurgingId(null); // a revoke state change always disarms any pending purge confirmation
    void withBusy(async () => {
      await patchGrant(secret!, id, { revoked });
    });
  }

  function handlePurge(id: string) {
    void withBusy(async () => {
      await purgeGrant(secret!, id);
      setPurgingId(null);
    });
  }

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

      {/* Mint */}
      <div className="mt-6 flex items-end gap-3">
        <div className="grow">
          <label htmlFor="mint-label" className="kicker block text-ink-soft">
            Issue new credential — codename
          </label>
          <input
            id="mint-label"
            value={mintLabel}
            onChange={(e) => setMintLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleMint();
            }}
            placeholder="alice"
            className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base text-ink placeholder-ink-faint/40 focus:border-brass focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={busy || !mintLabel.trim()}
          onClick={handleMint}
          className="kicker border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal disabled:opacity-40"
        >
          Mint
        </button>
      </div>

      {/* Show-once invite link */}
      {minted && (
        <div className="hairline mt-4 border border-brass/50 bg-inset p-4">
          <p className="kicker text-sienna">
            Invitation for “{minted.label}” — visible ONCE. Copy it now; only the codename
            survives.
          </p>
          <p className="mt-2 break-all font-type text-sm text-ink">{minted.link}</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(minted.link).then(() => setCopied(true));
              }}
              className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal"
            >
              {copied ? "✓ Copied" : "Copy Link"}
            </button>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="kicker px-4 py-2 text-ink-soft transition hover:text-vermilion"
            >
              Dismiss
            </button>
          </div>
          <p className="kicker mt-3 text-ink-soft">
            Send over an end-to-end encrypted channel (Signal, iMessage) — not email.
          </p>
        </div>
      )}

      <table className="mt-6 w-full text-left font-type text-sm">
        <thead>
          <tr className="kicker text-ink-soft">
            <th className="pb-2">Label</th>
            <th className="pb-2">Issued</th>
            <th className="pb-2">Last Used</th>
            <th className="pb-2">Status</th>
            <th className="pb-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id} className="border-t border-ink-faint/20">
              <td className="py-2 text-ink">
                {editingId === g.id ? (
                  <input
                    autoFocus
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRelabel(g.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="border-b border-brass bg-transparent font-type text-sm text-ink focus:outline-none"
                  />
                ) : (
                  g.label
                )}
              </td>
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
              <td className="py-2">
                <span className="flex gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(g.id);
                      setEditLabel(g.label);
                    }}
                    className="kicker text-ink-soft transition hover:text-signal"
                  >
                    Relabel
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleSetRevoked(g.id, !g.revokedAt)}
                    className="kicker text-ink-soft transition hover:text-vermilion"
                  >
                    {g.revokedAt ? "Restore" : "Revoke"}
                  </button>
                  {g.revokedAt &&
                    (purgingId === g.id ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handlePurge(g.id)}
                        className="kicker text-vermilion transition hover:text-vermilion-bright"
                      >
                        Confirm Purge
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setPurgingId(g.id)}
                        className="kicker text-ink-soft transition hover:text-vermilion"
                      >
                        Purge
                      </button>
                    ))}
                </span>
              </td>
            </tr>
          ))}
          {grants.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center font-body italic text-ink-soft">
                No credentials issued yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
