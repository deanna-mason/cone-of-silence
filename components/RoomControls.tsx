"use client";

import Link from "next/link";

interface RoomControlsProps {
  roomCode: string;
  onRoomCodeChange: (value: string) => void;
}

export default function RoomControls({ roomCode, onRoomCodeChange }: RoomControlsProps) {
  return (
    <div className="rounded-2xl border-4 border-slate-900 bg-white p-5 shadow-[6px_6px_0_0_#0f172a]">
      <label htmlFor="roomCode" className="block text-sm font-bold text-slate-900">
        Room code
      </label>
      <input
        id="roomCode"
        value={roomCode}
        onChange={(e) => onRoomCodeChange(e.target.value)}
        placeholder="e.g. quiet-otter-42"
        className="mt-1 w-full rounded-xl border-2 border-slate-900 bg-amber-50 px-3 py-2 text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-4 focus:ring-violet-300"
      />

      <div className="mt-5 rounded-xl border-2 border-dashed border-violet-400 bg-violet-50 p-4 text-center">
        <p className="text-sm font-bold text-violet-700">
          👇 This is a mockup — click here to see my project brainstorm!
        </p>
        <Link
          href="/brainstorm"
          className="mt-3 inline-flex items-center gap-2 rounded-xl border-4 border-slate-900 bg-orange-400 px-8 py-4 text-xl font-extrabold text-slate-900 shadow-[6px_6px_0_0_#0f172a] transition hover:-translate-y-1 hover:bg-orange-300 active:translate-y-0 active:shadow-[3px_3px_0_0_#0f172a]"
        >
          Create room
          <span className="inline-block animate-bounce">👉</span>
        </Link>
      </div>

      <button
        type="button"
        className="mt-4 w-full rounded-xl border-2 border-slate-900 bg-white px-4 py-2 text-sm font-bold text-slate-500 transition hover:bg-slate-50"
      >
        Join existing room
      </button>
    </div>
  );
}
