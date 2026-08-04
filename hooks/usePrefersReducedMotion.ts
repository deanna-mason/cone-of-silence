// hooks/usePrefersReducedMotion.ts
// True when the viewer asked the OS to reduce motion. Read via matchMedia in
// an effect (never during render) so the server render and first paint are
// motion-on — the default — and no hydration mismatch occurs. Components use
// it to drop the eased iris transition, the bloom breathing, the caption-dot
// pulse, and the slate flash for a hard-cut experience.
"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}
