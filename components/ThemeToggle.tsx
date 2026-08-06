// DAY / NIGHT, in the nav bar's own typography. Two plain-text buttons and the
// same brass "/" the link row uses — no icon, no border, no padding, so the
// control cannot grow the nav row (app/room/page.tsx sizes the in-call grid off
// a measured chrome height, and an e2e geometry assertion at 390×844 pins it).
//
// Which word is lit comes from CSS (--theme-day / --theme-night in
// app/globals.css), NOT from `theme` below — the server cannot know the OS
// preference, so a JS-driven colour would flash the wrong word on every
// dark-OS load. `theme` drives aria-pressed only.
"use client";

import { Fragment, useLayoutEffect, useSyncExternalStore } from "react";
import {
  applyStoredTheme,
  readResolvedTheme,
  readResolvedThemeServerSnapshot,
  setTheme,
  subscribeTheme,
  type Theme,
} from "@/lib/theme";

const OPTIONS: { theme: Theme; word: string; label: string; tint: string }[] = [
  { theme: "light", word: "DAY", label: "Day theme", tint: "theme-day" },
  { theme: "dark", word: "NIGHT", label: "Night theme", tint: "theme-night" },
];

export default function ThemeToggle() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    readResolvedTheme,
    readResolvedThemeServerSnapshot,
  );

  // The inline <head> script sets data-theme during HTML parsing, which is all
  // a production build needs. In development React's Strict Mode remounts once
  // and resets <html> to the attributes it manages from JSX, dropping it — so
  // re-apply here. A no-op in production.
  // (next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md,
  //  "Re-applying attributes in development")
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);

  return (
    <span role="group" aria-label="Theme" className="flex items-center gap-2">
      {OPTIONS.map((option, i) => (
        <Fragment key={option.theme}>
          {i > 0 && (
            <span className="text-brass/40" aria-hidden="true">
              /
            </span>
          )}
          <button
            type="button"
            aria-label={option.label}
            aria-pressed={theme === option.theme}
            onClick={() => setTheme(option.theme)}
            // No custom focus ring: brass on the day palette measures 1.85:1
            // against the paper background, under the 3:1 WCAG 1.4.11 floor.
            // The UA default ring is what every other control in this app
            // uses and it stays visible in both palettes.
            className={`kicker ${option.tint} transition hover:text-signal`}
          >
            {option.word}
          </button>
        </Fragment>
      ))}
    </span>
  );
}
