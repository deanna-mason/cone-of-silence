"use client"; // Error boundaries must be Client Components (Next 16.2.9).

import { useEffect } from "react";

// Route-segment error boundary. Wraps every page below the root layout, so the
// NavBar and footer stay put while this fallback stands in for the blown page.
//
// Next 16.2.9 prop signature (node_modules/next/dist/docs/.../file-conventions/
// error.md): the recover affordance is `unstable_retry` — it re-fetches and
// re-renders the boundary's children. `reset` is still passed and documented as
// the "clear state without re-fetch" escape hatch, so we accept both and prefer
// the retry the docs recommend, falling back to reset on older runtimes.
export default function Error({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry?: () => void;
}) {
  useEffect(() => {
    // No telemetry sink in this app; the console is the field log.
    console.error(error);
  }, [error]);

  const recover = unstable_retry ?? reset;

  return (
    <section className="hairline border bg-inset p-8 text-center">
      <p className="kicker text-vermilion">◈ Transmission Failed</p>
      <h1 className="mt-3 font-display text-5xl tracking-[0.04em] text-ink">
        The Dispatch Went Dark
      </h1>
      <p className="mx-auto mt-3 max-w-md font-body text-ink-soft">
        Something failed mid-transmission and this page could not be brought up.
        The line is still open — retry to re-establish it, or return to the lobby
        and start a fresh channel.
      </p>
      {error.digest && (
        <p className="kicker mt-4 text-ink-faint">Case No. {error.digest}</p>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => recover()}
          className="kicker inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Retry Transmission
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberate full-document load: a blown error boundary should discard the client tree, not soft-navigate within it */}
        <a
          href="/"
          className="kicker inline-block border border-ink-faint/30 px-6 py-3 text-ink-soft transition hover:border-brass hover:text-signal"
        >
          Return to Lobby
        </a>
      </div>
    </section>
  );
}
