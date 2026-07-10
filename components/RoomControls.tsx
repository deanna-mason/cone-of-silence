"use client";

import Link from "next/link";

interface RoomControlsProps {
  roomCode: string;
  onRoomCodeChange: (value: string) => void;
}

export default function RoomControls({ roomCode, onRoomCodeChange }: RoomControlsProps) {
  return (
    <section className="hairline border bg-inset p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-sienna">Briefing Panel</p>
        <p className="kicker text-ink-soft">File CS-000</p>
      </div>

      <label htmlFor="roomCode" className="kicker mt-5 block text-ink-soft">
        Room Cipher
      </label>
      <input
        id="roomCode"
        value={roomCode}
        onChange={(e) => onRoomCodeChange(e.target.value)}
        placeholder="quiet-otter-42"
        className="mt-2 w-full border-b-2 border-ink-faint/40 bg-transparent pb-2 font-type text-xl tracking-widest text-ink placeholder-ink-faint/40 focus:border-brass focus:outline-none"
      />

      {/* Primary action — unmistakable */}
      <div className="mt-8 border border-dashed border-vermilion/50 p-5">
        <p className="kicker text-vermilion">▼ Mockup — begin here</p>
        <Link
          href="/brainstorm"
          className="cta-glow group mt-3 flex w-full items-center justify-between gap-3 bg-vermilion px-6 py-5 font-display text-3xl tracking-[0.06em] text-cream transition hover:bg-vermilion-bright"
        >
          <span>Initiate Contact</span>
          <span aria-hidden className="font-body text-2xl transition group-hover:translate-x-1">
            ➔
          </span>
        </Link>
        <p className="mt-3 font-body text-sm italic text-ink-soft">
          Opens the mission dossier — the plan for the full app.
        </p>
      </div>

      <button
        type="button"
        className="kicker mt-5 w-full border border-ink-faint/30 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
      >
        Access Existing Channel
      </button>
    </section>
  );
}
