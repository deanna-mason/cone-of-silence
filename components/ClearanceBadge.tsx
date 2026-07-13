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

export default function ClearanceBadge({ clearance, onBurn }: Props) {
  const [confirming, setConfirming] = useState(false);

  if (clearance.state === "none") return null;

  if (clearance.state === "inactive") {
    return (
      <p role="alert" className="kicker text-vermilion">
        ✕ this invitation is no longer active
      </p>
    );
  }

  return (
    <div className="hairline flex items-center justify-between border bg-inset px-4 py-3">
      <p className="kicker text-brass">
        {clearance.state === "accepted"
          ? "✓ credentials accepted — you are cleared to initiate contact"
          : clearance.state === "unreachable"
            ? "CLEARANCE: ON FILE — channel unavailable, will verify on use"
            : "CLEARANCE: ACTIVE"}
      </p>
      {confirming ? (
        <span className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              onBurn();
              setConfirming(false);
            }}
            className="kicker text-vermilion transition hover:text-vermilion-bright"
          >
            CONFIRM BURN
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="kicker text-ink-soft transition hover:text-ink"
          >
            KEEP
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="Removes the credential from THIS browser only — the invitation itself stays valid until revoked by the issuer."
          className="kicker text-ink-soft transition hover:text-vermilion"
        >
          BURN CREDENTIALS
        </button>
      )}
    </div>
  );
}
