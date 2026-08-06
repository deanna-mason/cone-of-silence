"use client";

import { useState } from "react";
import { buildRoomHash, createRoomKeys, parseInviteLink } from "@/lib/roomLink";

// Case-file actions: create (invitation-gated) and a one-gesture join. Room
// entry is a FULL page load — window.location.assign — because the hash router
// corrupts nav. Do not switch to the client router.
export default function RoomControls({ canCreate }: { canCreate: boolean }) {
  const [invite, setInvite] = useState("");
  const [rejected, setRejected] = useState(false);

  function initiateContact() {
    window.location.assign(`/room${buildRoomHash(createRoomKeys())}`);
  }

  function accessChannel() {
    const keys = parseInviteLink(invite);
    if (!keys) {
      setRejected(true);
      return;
    }
    window.location.assign(`/room${buildRoomHash(keys)}`);
  }

  return (
    <>
      {/* Primary action — create (invitation-gated) */}
      {canCreate ? (
        <button
          type="button"
          onClick={initiateContact}
          className="cta-glow group mt-6 flex w-full items-center justify-between gap-3 bg-vermilion px-5 py-4 font-display text-3xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright"
        >
          <span>Initiate Contact</span>
          <span aria-hidden className="transition group-hover:translate-x-1">
            ➔
          </span>
        </button>
      ) : (
        <div className="mt-6 border border-ink-faint/30 px-5 py-4">
          <p className="font-display text-3xl tracking-[0.06em] text-ink-faint">Initiate Contact</p>
          {/* Locked is not a dead end: the only route forward is the paste
              line directly below, so this says so instead of stopping at
              "sealed" (8/5 copy pass). The kicker stays short — at 0.32em
              tracking a sentence in it is unreadable — and the instruction
              rides underneath in body text. */}
          <p className="kicker mt-2 text-ink-soft">◈ Sealed — Invitation Required</p>
          <p className="mt-2 font-body text-sm text-ink-soft">
            Already hold an invite? Paste it in the line below to join.
          </p>
        </div>
      )}

      {/* Join — one gesture: prompt → paste → Join. Never gated. */}
      <label htmlFor="invite" className="kicker mt-8 block text-ink-soft">
        Received an invite?
      </label>
      <input
        id="invite"
        value={invite}
        onChange={(e) => {
          setInvite(e.target.value);
          setRejected(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") accessChannel();
        }}
        placeholder="paste the invite link here…"
        className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink placeholder-ink-faint/40 focus:border-brass focus:outline-none"
      />
      {rejected && (
        <p role="alert" className="kicker mt-2 text-vermilion">
          ✕ not one of ours — paste the full invite link
        </p>
      )}
      <button
        type="button"
        onClick={accessChannel}
        className="kicker group mt-4 flex w-full items-center justify-center gap-2 border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
      >
        <span>Join</span>
        <span aria-hidden className="transition group-hover:translate-x-1">
          ➔
        </span>
      </button>
    </>
  );
}
