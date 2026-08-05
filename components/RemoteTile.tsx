// components/RemoteTile.tsx
// One remote participant: VideoTile + the per-tile honesty layer (Phase 4C
// SIGNAL LOST badge; the speaking detector lives here too). Exists so the
// room page can map the roster without calling hooks in a loop.
"use client";

import { useEffect } from "react";
import VideoTile from "@/components/VideoTile";
import { useSignalLostBadge } from "@/hooks/useSignalLostBadge";
import { useSpeaking } from "@/hooks/useSpeaking";
import type { RemotePeer } from "@/lib/webrtc/session";

interface RemoteTileProps {
  peer: RemotePeer;
  label: string;
  /** While a take rolls, the composite cover-crops BOTH cameras — so the
   *  honest preview crops the partner tile too (CS-DR-04 2B "Iris Pan"). */
  episodeFrame?: boolean;
  /** The LATCHED speaking indicator from the room page (useSpeakerLatch) —
   *  what the tile actually draws. The raw detector below only reports
   *  rising edges up; drawing it directly is the per-word flashing the 8/4
   *  rework removed. */
  speaking?: boolean;
  /** Fires with this peer's id when their live detector goes true. */
  onSpeakingStart?: (peerId: string) => void;
}

export default function RemoteTile({
  peer,
  label,
  episodeFrame = false,
  speaking = false,
  onSpeakingStart,
}: RemoteTileProps) {
  const signalLost = useSignalLostBadge(peer.connectionState);
  const live = useSpeaking(peer.stream);
  useEffect(() => {
    if (live) onSpeakingStart?.(peer.peerId);
  }, [live, onSpeakingStart, peer.peerId]);
  return (
    <VideoTile
      fill
      stream={peer.stream}
      label={label}
      signalLost={signalLost}
      speaking={speaking}
      episodeFrame={episodeFrame}
    />
  );
}
