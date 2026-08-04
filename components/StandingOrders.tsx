"use client";

// Studio Home — "Standing Orders" (Exhibit A, approved 2026-08-03). A logged-in
// host's standing studio: one glowing action (Enter the Studio, reusing
// RoomControls' Initiate Contact idiom exactly) over a Transfer of Custody
// device handoff. Fully client-only — the E2EE room secret only ever moves
// between the URL fragment and localStorage, never to a server.
//
// HONEST NOTE on "Transfer of Custody": the burn countdown is a UI convenience,
// NOT a security boundary. The invite link is a bearer capability the moment it
// exists; hiding it locally after 5 minutes does not revoke it, and nothing
// server-side enforces single use. See docs/drills/podcast-dress-rehearsal.md.
//
// This surface is the logged-in landing on /studio (above the recordings
// library) — Deanna's confirmed home for it (the mockup's /home was not adopted).

import { useEffect, useRef, useState } from "react";
import { buildInviteLink, type RoomKeys } from "@/lib/roomLink";
import { markConvened, readLastConvened, readStudioName, setStudioName } from "@/lib/studioRoom";

const BURN_MS = 5 * 60 * 1000; // UI-only handoff-code lifetime
const DEFAULT_NAME = "Standing Studio";

function formatConvened(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

export default function StandingOrders({ room }: { room: RoomKeys }) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [editingName, setEditingName] = useState(false);
  const [convened, setConvened] = useState<string | null>(null);

  const [handoffOpen, setHandoffOpen] = useState(false);
  const [remainingMs, setRemainingMs] = useState(BURN_MS);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const deadlineRef = useRef<number>(0);

  useEffect(() => {
    setName(readStudioName() ?? DEFAULT_NAME);
    setConvened(readLastConvened());
  }, []);

  // Burn clock for the revealed handoff code — UI only (see file header).
  useEffect(() => {
    if (!handoffOpen) return;
    deadlineRef.current = Date.now() + BURN_MS;
    setRemainingMs(BURN_MS);
    const tick = window.setInterval(() => {
      const left = deadlineRef.current - Date.now();
      if (left <= 0) {
        window.clearInterval(tick);
        setHandoffOpen(false); // code hidden locally once the fuse runs out
        setRemainingMs(0);
      } else {
        setRemainingMs(left);
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [handoffOpen]);

  const inviteLink = buildInviteLink(room, window.location.origin);

  function enterStudio() {
    markConvened();
    window.location.assign(inviteLink); // full page load — the hash-navigation rule
  }

  function commitName(next: string) {
    setStudioName(next);
    setName(readStudioName() ?? DEFAULT_NAME);
    setEditingName(false);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked — the label swaps to a visible failure state so
      // the host knows to select and copy the link by hand.
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 2000);
    }
  }

  const mm = Math.floor(remainingMs / 60000);
  const ss = Math.floor((remainingMs % 60000) / 1000);
  const burnLabel = `burns in ${mm}:${String(ss).padStart(2, "0")}`;

  return (
    <section className="hairline border bg-inset p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-sienna">Standing Orders</p>
        <p className="kicker text-ink-soft">Standing Post</p>
      </div>

      {editingName ? (
        <input
          autoFocus
          aria-label="Studio name"
          defaultValue={name === DEFAULT_NAME ? "" : name}
          placeholder={DEFAULT_NAME}
          onBlur={(e) => commitName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName((e.target as HTMLInputElement).value);
            if (e.key === "Escape") setEditingName(false);
          }}
          className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-1 font-display text-4xl tracking-[0.04em] text-ink focus:border-brass focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingName(true)}
          title="Rename this studio"
          className="mt-2 block text-left font-display text-4xl tracking-[0.04em] text-ink transition hover:text-signal"
        >
          {name}
        </button>
      )}

      <dl className="mt-4 space-y-1 font-type text-sm text-ink-soft">
        <div className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-brass/70" />
          <span>Line: quiet — standing by</span>
        </div>
        <div>Seats: room for 4</div>
        <div>Last convened: {formatConvened(convened)}</div>
      </dl>

      {/* Enter the Studio — RoomControls' Initiate Contact idiom, reused exactly. */}
      <button
        type="button"
        onClick={enterStudio}
        className="cta-glow group mt-6 flex w-full items-center justify-between gap-3 bg-vermilion px-6 py-5 font-display text-3xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright"
      >
        <span>Enter the Studio</span>
        <span aria-hidden className="font-body text-2xl transition group-hover:translate-x-1">
          ➔
        </span>
      </button>

      <div className="mt-8">
        <p className="kicker text-ink-soft">Transfer of Custody</p>
        {!handoffOpen ? (
          <>
            <p className="mt-2 font-body text-sm italic text-ink-soft">
              Move your studio to another device. The link works until you close it.
            </p>
            <button
              type="button"
              onClick={() => setHandoffOpen(true)}
              className="kicker mt-3 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
            >
              Hand off to another device
            </button>
          </>
        ) : (
          <div className="mt-3 border border-ink-faint/30 p-4">
            <p className="break-all font-type text-sm tracking-wide text-ink">{inviteLink}</p>
            <div className="mt-3 flex items-center justify-between">
              <p className="kicker text-vermilion" aria-live="polite">
                ✕ {burnLabel}
              </p>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal"
              >
                {copied ? "LINK COPIED" : copyFailed ? "COPY FAILED — SELECT MANUALLY" : "Copy link"}
              </button>
            </div>
            <p className="mt-3 font-body text-xs italic text-ink-soft">
              Open this link at the other device&rsquo;s Identity Desk to pin the same studio. The
              countdown only hides the link here — it is a convenience, not a revocation.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
