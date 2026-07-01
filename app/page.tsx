"use client";

import { useState } from "react";
import RoomControls from "@/components/RoomControls";
import EncryptionToggle from "@/components/EncryptionToggle";

export default function LobbyPage() {
  const [roomCode, setRoomCode] = useState("");
  const [encryptionOn, setEncryptionOn] = useState(false);

  return (
    <div className="space-y-10">
      {/* Hero */}
      <header className="relative overflow-hidden">
        {/* Gun-barrel target motif */}
        <svg
          aria-hidden
          viewBox="0 0 200 200"
          className="barrel-spin pointer-events-none absolute -right-16 -top-20 h-64 w-64 text-vermilion/25"
        >
          <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="100" cy="100" r="72" fill="none" stroke="currentColor" strokeWidth="6" />
          <circle cx="100" cy="100" r="46" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="100" y1="0" x2="100" y2="200" stroke="currentColor" strokeWidth="1" />
          <line x1="0" y1="100" x2="200" y2="100" stroke="currentColor" strokeWidth="1" />
        </svg>

        <p className="kicker rise text-brass" style={{ animationDelay: "0.05s" }}>
          ◈ Secure Channel — Eyes Only
        </p>
        <h1
          className="rise font-display text-6xl leading-[0.9] tracking-[0.04em] text-paper sm:text-7xl"
          style={{ animationDelay: "0.15s" }}
        >
          Enter the
          <br />
          <span className="text-vermilion">Cone of Silence</span>
        </h1>
        <p
          className="rise mt-4 max-w-md font-body text-lg leading-relaxed text-paper-dim"
          style={{ animationDelay: "0.28s" }}
        >
          A private line for two. No recordings. No logs. No trace. When the call
          ends, it never happened.
        </p>
      </header>

      <div className="rise space-y-6" style={{ animationDelay: "0.4s" }}>
        <RoomControls roomCode={roomCode} onRoomCodeChange={setRoomCode} />
        <EncryptionToggle enabled={encryptionOn} onToggle={() => setEncryptionOn((v) => !v)} />
      </div>
    </div>
  );
}
