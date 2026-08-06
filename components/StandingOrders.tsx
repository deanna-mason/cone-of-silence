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

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { buildInviteLink, type RoomKeys } from "@/lib/roomLink";
import {
  clearStudioRoom,
  markConvened,
  readLastConvened,
  readStudioName,
  setStudioName,
} from "@/lib/studioRoom";

const BURN_MS = 5 * 60 * 1000; // UI-only handoff-code lifetime
const DEFAULT_NAME = "Standing Studio";

// Studio name is a localStorage read with no native change event, so it gets
// its own tiny pub-sub: commitName() below calls notifyStudioNameChange()
// right after writing, which is the only thing that ever needs to push a
// fresh read to the component (mirrors the old setName(...) call it replaces).
const nameSubscribers = new Set<() => void>();
function subscribeStudioName(cb: () => void) {
  nameSubscribers.add(cb);
  return () => nameSubscribers.delete(cb);
}
function notifyStudioNameChange() {
  nameSubscribers.forEach((cb) => cb());
}
function getStudioNameSnapshot(): string {
  return readStudioName() ?? DEFAULT_NAME;
}
// Matches the old useState(DEFAULT_NAME) initial value, so server render and
// first paint are unchanged — no hydration mismatch.
function getStudioNameServerSnapshot(): string {
  return DEFAULT_NAME;
}

// Last-convened has no live-update requirement: the only writer,
// markConvened(), fires immediately before a full-page navigation
// (window.location.assign), so nothing ever needs to observe it change
// in-place. A no-op subscribe preserves the original "read once on mount"
// behavior.
function noopSubscribe() {
  return () => {};
}
function getLastConvenedServerSnapshot(): string | null {
  return null;
}

function formatConvened(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

export default function StandingOrders({ room }: { room: RoomKeys }) {
  const name = useSyncExternalStore(
    subscribeStudioName,
    getStudioNameSnapshot,
    getStudioNameServerSnapshot,
  );
  const [editingName, setEditingName] = useState(false);
  const convened = useSyncExternalStore(noopSubscribe, readLastConvened, getLastConvenedServerSnapshot);

  const [handoffOpen, setHandoffOpen] = useState(false);
  const [remainingMs, setRemainingMs] = useState(BURN_MS);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const deadlineRef = useRef<number>(0);
  // Release is two-step for the same reason Transfer of Custody is: the stored
  // secret is the ONLY way back into a standing room. Releasing it without the
  // link in hand loses the room outright, so the first click arms and warns.
  const [releaseArmed, setReleaseArmed] = useState(false);

  // Burn clock for the revealed handoff code — UI only (see file header).
  // deadlineRef/remainingMs are armed in the "Hand off" click handler below,
  // the event that causes the burn window to open; this effect only owns the
  // 1 Hz tick while handoffOpen is true (duration/cadence unchanged).
  useEffect(() => {
    if (!handoffOpen) return;
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
    notifyStudioNameChange();
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

      {/* The lamp and "Line: quiet — standing by" were removed 8/5: both were
          hardcoded, so the dot reported a line state nothing ever measured.
          The two facts below are real reads. */}
      <dl className="mt-4 space-y-1 font-type text-sm text-ink-soft">
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
            {/* "Your own device, not a guest" is a real distinction, not
                etiquette: this is the STANDING studio's secret, the same room
                every time, and lib/studioRoom.ts keeps it as the only way back
                in. A guest handed this link holds that key permanently. The
                disposable alternative is the lobby's Initiate Contact, which
                mints fresh keys per room (RoomControls.tsx). The old copy said
                "bearer key ... and to no one else" without ever saying why, or
                where to send a guest instead. */}
            <p className="mt-2 font-body text-sm italic text-ink-soft">
              The key to this studio. Anyone who opens it walks in, and you cannot call it back.
              <br />
              Your studio never leaves this browser, so this link is the only way onto another
              device.
              <br />
              For a guest, open a fresh line from the lobby instead.
            </p>
            <button
              type="button"
              onClick={() => {
                // Arm the burn clock here, in the event that opens the
                // handoff panel, rather than as a state write inside the
                // tick effect — same duration/cadence, just triggered by the
                // click instead of derived in the effect.
                deadlineRef.current = Date.now() + BURN_MS;
                setRemainingMs(BURN_MS);
                setHandoffOpen(true);
              }}
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
            {/* This link opens /room directly — it does NOT pin a studio, and
                the Identity Desk (/account) cannot read it: that page parses a
                different fragment (#invite=…&r=&s=). The room also only exists
                on the server while someone is seated in it (30s grace, see
                server/src/rooms/registry.ts), so a link opened cold reports
                "This Corridor Is Dark". Both facts were missing from the old
                copy, which sent hosts hunting for somewhere to paste it. */}
            <p className="mt-3 font-body text-xs italic text-ink-soft">
              Stay in the studio, then open this link on your other device. It walks straight in.
              <br />
              If you leave, the link stops working until you are back.
              <br />
              The countdown hides the link here. It does not revoke it.
            </p>
          </div>
        )}
      </div>

      {/* Release — the exit clearStudioRoom() shipped without. */}
      <div className="mt-8">
        <p className="kicker text-ink-soft">Stand Down</p>
        {!releaseArmed ? (
          <button
            type="button"
            onClick={() => setReleaseArmed(true)}
            className="kicker mt-3 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-vermilion hover:text-vermilion"
          >
            Release this studio
          </button>
        ) : (
          <div className="mt-3 border border-vermilion/60 p-4">
            <p className="font-body text-sm text-ink">
              ✕ This releases <span className="italic">{name}</span>. Its link is the only way back
              in — keep it before you continue.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => clearStudioRoom()}
                className="kicker border border-vermilion/60 px-4 py-2 text-vermilion transition hover:bg-vermilion hover:text-cream"
              >
                Release it
              </button>
              <button
                type="button"
                onClick={() => setReleaseArmed(false)}
                className="kicker border border-ink-faint/30 px-4 py-2 text-ink-soft transition hover:border-brass hover:text-signal"
              >
                Keep {name}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
