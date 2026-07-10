import Link from "next/link";

export default function NavBar() {
  return (
    <nav className="hairline sticky top-0 z-40 border-b bg-field/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="group flex items-center gap-3">
          <span className="relative grid h-6 w-6 place-items-center rounded-full border-2 border-vermilion">
            <span className="h-1.5 w-1.5 rounded-full bg-vermilion transition group-hover:scale-150" />
          </span>
          <span className="font-display text-2xl leading-none tracking-[0.12em] text-ink">
            CONE OF SILENCE
          </span>
        </Link>

        <div className="flex items-center gap-5 text-ink-soft">
          <Link
            href="/"
            className="kicker transition hover:text-signal"
          >
            Lobby
          </Link>
          <span className="text-brass/40">/</span>
          <Link
            href="/brainstorm"
            className="kicker transition hover:text-signal"
          >
            Dossier
          </Link>
        </div>
      </div>
    </nav>
  );
}
