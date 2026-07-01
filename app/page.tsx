"use client";

import { useState } from "react";
import RoomControls from "@/components/RoomControls";
import EncryptionToggle from "@/components/EncryptionToggle";

export default function LobbyPage() {
  const [roomCode, setRoomCode] = useState("");
  const [encryptionOn, setEncryptionOn] = useState(false);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-white">Start a private call</h1>
        <p className="mt-1 text-slate-400">
          Nothing is stored. No history, no room list — just you and whoever you invite.
        </p>
      </header>

      <RoomControls roomCode={roomCode} onRoomCodeChange={setRoomCode} />
      <EncryptionToggle enabled={encryptionOn} onToggle={() => setEncryptionOn((v) => !v)} />
    </div>
  );
}
