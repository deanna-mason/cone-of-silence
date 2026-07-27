// hooks/useSignalLostBadge.ts
// Anti-flash SIGNAL LOST badge state (spec §4C, Deanna's requirement):
// `disconnected` often self-heals in 1–3s, so the badge appears only after a
// continuous bad-state delay; `failed` doesn't self-heal, so it shows fast;
// and once visible the badge holds a minimum beat so it can never
// single-frame flicker. A one-second frozen face shows nothing.
"use client";

import { useEffect, useRef, useState } from "react";

export const BADGE_DELAY_MS = 3_000;
export const BADGE_MIN_SHOW_MS = 1_000;

export function useSignalLostBadge(state: RTCPeerConnectionState): boolean {
  const [shown, setShown] = useState(false);
  const shownAtRef = useRef(0);

  useEffect(() => {
    const bad = state === "disconnected" || state === "failed";
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (bad) {
      const show = () => {
        shownAtRef.current = Date.now();
        setShown(true);
      };
      if (state === "failed") show();
      else timer = setTimeout(show, BADGE_DELAY_MS);
    } else {
      const held = Date.now() - shownAtRef.current;
      if (held >= BADGE_MIN_SHOW_MS) setShown(false);
      else timer = setTimeout(() => setShown(false), BADGE_MIN_SHOW_MS - held);
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [state]);

  return shown;
}
