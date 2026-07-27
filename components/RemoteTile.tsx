// components/RemoteTile.tsx
// One remote participant: VideoTile + the per-tile honesty layer (Phase 4C
// SIGNAL LOST badge; the speaking glow joins in the same slice). Exists so
// the room page can map the roster without calling hooks in a loop.
"use client";

import VideoTile from "@/components/VideoTile";
import { useSignalLostBadge } from "@/hooks/useSignalLostBadge";
import { useSpeaking } from "@/hooks/useSpeaking";
import type { RemotePeer } from "@/lib/webrtc/session";

interface RemoteTileProps {
  peer: RemotePeer;
  label: string;
}

export default function RemoteTile({ peer, label }: RemoteTileProps) {
  const signalLost = useSignalLostBadge(peer.connectionState);
  const speaking = useSpeaking(peer.stream);
  return (
    <VideoTile fill stream={peer.stream} label={label} signalLost={signalLost} speaking={speaking} />
  );
}
