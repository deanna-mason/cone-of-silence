import Link from "next/link";

// Renders inside the root layout (NavBar + footer stay), so this is just the
// inner card. Handles both notFound() calls and any unmatched URL for the app.
export default function NotFound() {
  return (
    <section className="hairline border bg-inset p-8 text-center">
      <p className="kicker text-vermilion">◈ No Such Corridor</p>
      <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">
        This File Is Not on Record
      </h1>
      <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">
        The address you followed leads nowhere in the archive. It may have been
        struck, or it was never filed. Return to the lobby and try a known
        channel.
      </p>
      <Link
        href="/"
        className="kicker mt-6 inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
      >
        Return to Lobby
      </Link>
    </section>
  );
}
