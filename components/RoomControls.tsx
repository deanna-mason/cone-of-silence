"use client";

import Link from "next/link";

interface RoomControlsProps {
  roomCode: string;
  onRoomCodeChange: (value: string) => void;
}

export default function RoomControls({ roomCode, onRoomCodeChange }: RoomControlsProps) {
  return (
    <section className="hairline border bg-panel/60 p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-brass">Briefing Panel</p>
        <p className="kicker text-paper-dim">File CS-000</p>
      </div>

      <label htmlFor="roomCode" className="kicker mt-5 block text-paper-dim">
        Room Cipher
      </label>
      <input
        id="roomCode"
        value={roomCode}
        onChange={(e) => onRoomCodeChange(e.target.value)}
        placeholder="quiet-otter-42"
        className="mt-2 w-full border-b-2 border-paper-dim/40 bg-transparent pb-2 font-type text-xl tracking-widest text-paper placeholder-paper-dim/40 focus:border-brass focus:outline-none"
      />

      {/* Primary action — unmistakable */}
      <div className="mt-8 border border-dashed border-vermilion/50 p-5">
        <p className="kicker text-vermilion">▼ Mockup — begin here</p>
        <Link
          href="/brainstorm"
          className="cta-glow group mt-3 flex w-full items-center justify-between gap-3 bg-vermilion px-6 py-5 font-display text-3xl tracking-[0.06em] text-paper transition hover:bg-vermilion-bright"
        >
          <span>Initiate Contact</span>
          <span aria-hidden className="font-body text-2xl transition group-hover:translate-x-1">
            ➔
          </span>
        </Link>
        <p className="mt-3 font-body text-sm italic text-paper-dim">
          Opens the mission dossier — the plan for the full app.
        </p>
      </div>

      <button
        type="button"
        className="kicker mt-5 w-full border border-paper-dim/30 py-3 text-paper-dim transition hover:border-brass hover:text-brass"
      >
        Access Existing Channel
      </button>
    </section>
  );
}
