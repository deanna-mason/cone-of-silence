// hooks/useSpeakerLatch.ts — the room's latched speaking indicator (8/4
// dress-rehearsal rework). The raw per-tile detector (useSpeaking) flickers
// with the gaps between words; drawn directly it reads as flashing. This
// latch holds the outline on the MOST RECENT speaker until a DIFFERENT
// person speaks — it never goes dark on its own.
"use client";

import { useCallback, useState } from "react";

/** The local seat's id in the latch. Peer ids are 22-char generated tokens,
 *  so the literal can't collide. */
export const SELF_SPEAKER = "self";

export function useSpeakerLatch(selfSpeaking: boolean): {
  /** SELF_SPEAKER, a peerId, or null before anyone has spoken. */
  lastSpeaker: string | null;
  /** Report a remote detector's rising edge (RemoteTile calls this). */
  noteSpeaker: (peerId: string) => void;
} {
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  // Rising-edge detection for the local seat, as a render-time state
  // adjustment (the documented "storing information from previous renders"
  // pattern — no effect, no ref-in-render).
  const [prevSelfSpeaking, setPrevSelfSpeaking] = useState(false);
  if (selfSpeaking !== prevSelfSpeaking) {
    setPrevSelfSpeaking(selfSpeaking);
    if (selfSpeaking) setLastSpeaker(SELF_SPEAKER);
  }
  const noteSpeaker = useCallback((peerId: string) => setLastSpeaker(peerId), []);
  return { lastSpeaker, noteSpeaker };
}
