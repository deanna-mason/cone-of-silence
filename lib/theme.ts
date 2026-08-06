// lib/theme.ts
// The viewer's day/night choice. This module is NOT the palette — every colour
// still lives in app/globals.css. All it decides is which of three states the
// document is in:
//
//   no data-theme attribute → follow the OS (@media prefers-color-scheme)
//   data-theme="light"      → forced DAY
//   data-theme="dark"       → forced NIGHT
//
// The attribute carries a VALUE rather than being a bare `data-dark` flag
// because a viewer on a dark OS has to be able to force DAY, which a dark-only
// selector could never express. How the forced states beat the media query is
// a cascade detail, documented at the top of app/globals.css — it is not
// specificity, and the comment there is the accurate one.
//
// Note the first state is the INITIAL state, not a reachable one: the nav
// exposes two buttons, so once a viewer chooses, they have chosen. This is
// deliberate — a third "Auto" control does not fit the nav row's fixed 720px
// (see components/NavBar.tsx) and two-state is the common convention.
//
// The choice is persisted to localStorage and re-applied before first paint by
// THEME_NO_FLASH_SCRIPT, which app/layout.tsx runs inline in <head>. Same tiny
// pub-sub idiom as lib/studioRoom.ts: localStorage fires no native event for a
// same-tab write, and the nav toggle reads this through useSyncExternalStore.

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "cos-theme";
export const THEME_ATTRIBUTE = "data-theme";

const OS_DARK_QUERY = "(prefers-color-scheme: dark)";

function osMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(OS_DARK_QUERY);
}

const subscribers = new Set<() => void>();

function notifyThemeChange(): void {
  subscribers.forEach((cb) => cb());
}

export function subscribeTheme(cb: () => void): () => void {
  subscribers.add(cb);
  // With no explicit choice the resolved theme IS the OS's, so an OS flip
  // mid-session has to repaint the toggle's pressed state as well.
  const mq = osMediaQuery();
  mq?.addEventListener?.("change", cb);
  return () => {
    subscribers.delete(cb);
    mq?.removeEventListener?.("change", cb);
  };
}

/** The explicit choice, or null while the viewer is still following the OS. */
export function readThemeChoice(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    // storage unavailable — treat it as "no choice made", i.e. follow the OS
    return null;
  }
}

function readOsTheme(): Theme {
  return osMediaQuery()?.matches ? "dark" : "light";
}

/** The theme actually being painted: the explicit choice, else the OS's. */
export function readResolvedTheme(): Theme {
  return readThemeChoice() ?? readOsTheme();
}

// Server render never touches localStorage or matchMedia — the documented SSR
// contract this codebase already follows in app/studio/page.tsx and
// hooks/usePrefersReducedMotion.ts. useSyncExternalStore resyncs to the real
// value in the hydration pass. Only the toggle's aria-pressed rides on this;
// the painted colours come from CSS, so nothing visible flashes (see the
// --theme-day / --theme-night note in app/globals.css).
export function readResolvedThemeServerSnapshot(): Theme {
  return "light";
}

function applyThemeAttribute(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) root.setAttribute(THEME_ATTRIBUTE, theme);
  else root.removeAttribute(THEME_ATTRIBUTE);
}

/** Commits an explicit choice: persist it, repaint, and wake the subscribers. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable — the choice just won't survive this tab
  }
  applyThemeAttribute(theme);
  // Fires even when the write above threw, so the toggle reflects what is
  // actually on screen rather than a phantom persisted choice.
  notifyThemeChange();
}

/** Re-applies the stored choice (or clears the attribute when there is none). */
export function applyStoredTheme(): void {
  applyThemeAttribute(readThemeChoice());
}

// Runs synchronously in <head> while the browser parses the HTML, so the
// attribute is on <html> before the first paint. Deliberately does NOTHING
// when no choice is stored: the bare document follows the OS through the
// media query, which is the unchanged default for a first visit.
export const THEME_NO_FLASH_SCRIPT =
  `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(t==="light"||t==="dark")document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t)}` +
  `catch(e){}})()`;
