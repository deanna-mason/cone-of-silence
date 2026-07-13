"use client";

import { useState } from "react";
import { buildRoomHash, createRoomKeys, parseInviteLink } from "@/lib/roomLink";

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
    <section className="hairline border bg-inset p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-sienna">Briefing Panel</p>
        <p className="kicker text-ink-soft">File CS-001</p>
      </div>

      {/* Primary action — create (invitation-gated) */}
      {canCreate ? (
        <>
          <button
            type="button"
            onClick={initiateContact}
            className="cta-glow group mt-6 flex w-full items-center justify-between gap-3 bg-vermilion px-6 py-5 font-display text-3xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright"
          >
            <span>Initiate Contact</span>
            <span aria-hidden className="font-body text-2xl transition group-hover:translate-x-1">
              ➔
            </span>
          </button>
          <p className="mt-3 font-body text-sm italic text-ink-soft">
            Opens a fresh channel and hands you the only key — share the invite link with your
            contacts.
          </p>
        </>
      ) : (
        <div className="mt-6 border border-ink-faint/30 px-6 py-5">
          <p className="font-display text-3xl tracking-[0.06em] text-ink-faint">
            Initiate Contact
          </p>
          <p className="kicker mt-2 text-ink-soft">🔒 creation requires an invitation</p>
          <p className="mt-2 font-body text-sm italic text-ink-soft">
            Ask the operator for an invitation link to open channels of your own. Joining an
            existing channel needs no clearance — paste your invite below.
          </p>
        </div>
      )}

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
        placeholder="https://…/room#r=…&s=…"
        className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-base tracking-wide text-ink placeholder-ink-faint/40 focus:border-brass focus:outline-none"
      />
      {rejected && (
        <p role="alert" className="kicker mt-2 text-vermilion">
          ✕ This document is not one of ours — paste the full invite link.
        </p>
      )}
      <button
        type="button"
        onClick={accessChannel}
        className="kicker mt-4 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
      >
        Access Existing Channel
      </button>
    </section>
  );
}
