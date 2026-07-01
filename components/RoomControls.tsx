"use client";

import Link from "next/link";

interface RoomControlsProps {
  roomCode: string;
  onRoomCodeChange: (value: string) => void;
}

export default function RoomControls({ roomCode, onRoomCodeChange }: RoomControlsProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <label htmlFor="roomCode" className="block text-sm font-medium text-slate-300">
        Room code
      </label>
      <input
        id="roomCode"
        value={roomCode}
        onChange={(e) => onRoomCodeChange(e.target.value)}
        placeholder="e.g. quiet-otter-42"
        className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
      />

      <div className="mt-4 flex items-center gap-3">
        <Link
          href="/brainstorm"
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          Create room →
        </Link>
        <button
          type="button"
          className="rounded-md border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
        >
          Join room
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        (Mockup — click &ldquo;Create room&rdquo; to view my project brainstorm.)
      </p>
    </div>
  );
}
