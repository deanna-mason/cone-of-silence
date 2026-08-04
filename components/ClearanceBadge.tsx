"use client";

import { useState } from "react";

export type Clearance =
  | { state: "none" }
  | { state: "active" }
  | { state: "accepted" } // just arrived via invite link this visit
  | { state: "inactive" } // token was revoked server-side
  | { state: "unreachable" }; // stored, but server couldn't confirm

interface Props {
  clearance: Clearance;
  onBurn: () => void;
}

// Woven into the case-file "Clearance" dossier row: the state is the row's
// value, and the BURN control (local shred only) rides alongside it.
export default function ClearanceBadge({ clearance, onBurn }: Props) {
  const [confirming, setConfirming] = useState(false);

  if (clearance.state === "none") {
    return <span className="text-ink-faint">None on file</span>;
  }

  if (clearance.state === "inactive") {
    return (
      <span role="alert" className="text-vermilion">
        ✕ this invitation is no longer active
      </span>
    );
  }

  const label =
    clearance.state === "accepted"
      ? "Credentials accepted ✓"
      : clearance.state === "unreachable"
        ? "On file — will verify on use"
        : "Invitation on file ✓";

  return (
    <span className="flex items-center gap-3">
      <span className="text-brass">{label}</span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              onBurn();
              setConfirming(false);
            }}
            className="text-vermilion transition hover:text-vermilion-bright"
          >
            CONFIRM BURN
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="text-ink-soft transition hover:text-ink"
          >
            KEEP
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="Removes the credential from THIS browser only — the invitation itself stays valid until revoked by the issuer."
          className="text-ink-soft transition hover:text-vermilion"
        >
          BURN CREDENTIALS
        </button>
      )}
    </span>
  );
}
