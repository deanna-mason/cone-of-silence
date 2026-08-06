"use client"; // Error boundaries must be Client Components (Next 16.3.0).

import { useEffect } from "react";

// Route-segment error boundary. Wraps every page below the root layout, so the
// NavBar and footer stay put while this fallback stands in for the blown page.
//
// Next 16.3.0 prop signature (node_modules/next/dist/docs/.../file-conventions/
// error.md): the recover affordance is `retry`, stable as of this version and
// typed required there — it "will try to re-fetch and re-render the error
// boundary's children", which is the stronger behavior the copy below promises
// ("The line is still open — retry to re-establish it"). `reset` is also passed
// and documented as the narrower escape hatch: it clears the error state and
// re-renders the children WITHOUT re-fetching. The docs are explicit that "In
// most cases, you should use retry() instead", so retry wins and reset is the
// fallback.
//
// That fallback is not dead code despite `retry` being required. This prop was
// `unstable_retry` in 16.2.x and only stabilized under its current name in
// 16.3.0 (error.md Version History) — the required type is a compile-time
// promise an older runtime would not keep. If this app is ever run against one,
// recovery degrades to a re-render instead of throwing on undefined.
export default function Error({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) {
  useEffect(() => {
    // No telemetry sink in this app; the console is the field log.
    console.error(error);
  }, [error]);

  const recover = retry ?? reset;

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
