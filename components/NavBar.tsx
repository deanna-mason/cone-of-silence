"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";

const LINKS = [
  { href: "/", label: "Lobby" },
  { href: "/studio", label: "Studio" },
  { href: "/account", label: "Account" },
];

// The kicker links (Special_Elite at 0.32em tracking) are expensive: back when
// there were four they overran a 390px viewport as an inline row (7/30
// testers), and adding DAY / NIGHT pushed the row to 799px — wider than the
// max-w-3xl container's 720px of inner width, which gave EVERY page a
// horizontal scrollbar from 640px to ~838px (measured; iPad portrait clipped
// "NIGHT" mid-word). Retiring /brainstorm bought that width back.
//
// So the collapse point is lg, not sm: below 1024px the whole set — links and
// theme toggle — lives in a menu button + absolute dropdown, and the nav BAR
// stays a single row of the same height. The room no-scroll geometry
// (100svh − 7rem in app/room/page.tsx) depends on that height not growing.
export default function NavBar() {
  const [open, setOpen] = useState(false);
  return (
    <nav className="hairline sticky top-0 z-40 border-b bg-field/85 backdrop-blur-sm">
      <div className="relative mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
        <Link
          href="/"
          onClick={() => setOpen(false)}
          className="group flex shrink-0 items-center gap-3"
        >
          <span className="relative grid h-6 w-6 place-items-center rounded-full border-2 border-vermilion">
            <span className="h-1.5 w-1.5 rounded-full bg-vermilion transition group-hover:scale-150" />
          </span>
          <span className="whitespace-nowrap font-display text-xl leading-none tracking-[0.12em] text-ink sm:text-2xl">
            CONE OF SILENCE
          </span>
        </Link>

        {/* Desktop: the inline link row. */}
        {/* The container is max-w-3xl, so this row has a FIXED 720px of inner
            width at EVERY viewport — raising the collapse breakpoint can never
            buy it more. It must simply fit in 720px, with enough slack that a
            webfont fallback (Special Elite → Courier New, appreciably wider)
            cannot push it over. */}
        <div className="hidden items-center gap-5 text-ink-soft lg:flex">
          {LINKS.map((l, i) => (
            <Fragment key={l.href}>
              {i > 0 && <span className="text-brass/40">/</span>}
              <Link href={l.href} className="kicker transition hover:text-signal">
                {l.label}
              </Link>
            </Fragment>
          ))}
          {/* A hairline rule, not another "/": the toggle is a setting, not a
              fourth destination, and the rule says so. mx-2 on top of the row
              gap widens the gutter on BOTH sides of the rule past the 20px
              between links, so the toggle reads as its own group rather than
              crowding the rule. */}
          <span aria-hidden className="mx-2 h-3 w-px shrink-0 bg-brass/40" />
          <ThemeToggle />
        </div>

        {/* Mobile: a compact toggle (kept shorter than the 24px logo so the
            nav bar height is unchanged from the inline row). */}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((v) => !v)}
          className="kicker shrink-0 border border-ink-faint/30 px-2.5 py-1 text-ink-soft transition hover:border-brass hover:text-signal lg:hidden"
        >
          {open ? "Close" : "Menu"}
        </button>

        {/* Mobile dropdown — absolutely positioned so it overlays content and
            never adds to the nav bar's own height. */}
        {open && (
          <div
            id="nav-menu"
            className="hairline absolute left-0 right-0 top-full flex flex-col border-b bg-field/95 text-ink-soft backdrop-blur-sm lg:hidden"
          >
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="kicker border-t border-ink-faint/15 px-6 py-4 transition hover:text-signal"
              >
                {l.label}
              </Link>
            ))}
            {/* A dropdown row like the others — never beside the Menu button,
                which would grow the bar itself. Choosing a theme leaves the
                menu open so the palette change is visible behind it. */}
            <div className="flex items-center border-t border-ink-faint/15 px-6 py-4">
              <ThemeToggle />
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
