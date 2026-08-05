// hooks/usePrefersReducedMotion.ts
// True when the viewer asked the OS to reduce motion. Read via matchMedia
// through useSyncExternalStore, whose getServerSnapshot always returns false
// so the server render and first paint are motion-on — the default — and no
// hydration mismatch occurs; the real matchMedia value takes over right
// after mount. Components use it to drop the eased iris transition, the
// bloom breathing, the caption-dot pulse, and the slate flash for a hard-cut
// experience.
"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

function getSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : false;
}

// Server render and first paint are motion-on (false) — the documented
// hydration contract above. useSyncExternalStore resyncs to the real
// matchMedia value right after mount, same timing as the old effect.
function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
