"use client";

import { Fragment, useState } from "react";
import Link from "next/link";

const LINKS = [
  { href: "/", label: "Lobby" },
  { href: "/brainstorm", label: "Dossier" },
  { href: "/studio", label: "Studio" },
  { href: "/account", label: "Account" },
];

// The four kicker links (Special_Elite at 0.32em tracking) overrun a 390px
// viewport as an inline row (7/30 testers). Below sm they collapse into a
// menu button + an absolute dropdown, so the nav BAR itself stays a single
// row of the same height — the room no-scroll geometry (100svh − 7rem in
// app/room/page.tsx) depends on the chrome height not growing on mobile.
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
        <div className="hidden items-center gap-5 text-ink-soft sm:flex">
          {LINKS.map((l, i) => (
            <Fragment key={l.href}>
              {i > 0 && <span className="text-brass/40">/</span>}
              <Link href={l.href} className="kicker transition hover:text-signal">
                {l.label}
              </Link>
            </Fragment>
          ))}
        </div>

        {/* Mobile: a compact toggle (kept shorter than the 24px logo so the
            nav bar height is unchanged from the inline row). */}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-controls="nav-menu"
          onClick={() => setOpen((v) => !v)}
          className="kicker shrink-0 border border-ink-faint/30 px-2.5 py-1 text-ink-soft transition hover:border-brass hover:text-signal sm:hidden"
        >
          {open ? "Close" : "Menu"}
        </button>

        {/* Mobile dropdown — absolutely positioned so it overlays content and
            never adds to the nav bar's own height. */}
        {open && (
          <div
            id="nav-menu"
            className="hairline absolute left-0 right-0 top-full flex flex-col border-b bg-field/95 text-ink-soft backdrop-blur-sm sm:hidden"
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
          </div>
        )}
      </div>
    </nav>
  );
}
