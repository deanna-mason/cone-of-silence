"use client"; // Error boundaries must be Client Components (Next 16.3.0).

import { useEffect } from "react";

// The last line of defense: an error thrown by the ROOT layout itself is not
// caught by app/error.tsx — it is caught here. Per the Next 16.3.0 docs
// (node_modules/next/dist/docs/.../file-conventions/error.md#global-error) this
// file REPLACES the root layout, so it must render its own <html>/<body> and
// carry its own styles and fonts — none of globals.css, next/font, or the
// NavBar are available in this scope.
//
// Everything is inlined on purpose: if the failure that reached this boundary
// was the CSS/font bundle failing to load, an inline-styled page still renders.
// Fonts fall back to the same families globals.css declares as fallbacks
// (Arial Narrow / Courier New / Georgia). This is the "night ops" palette — a
// total blackout gets the dark dossier look.
const TYPE = '"Courier New", ui-monospace, monospace';
const DISPLAY = '"Arial Narrow", sans-serif';
const BODY = "Georgia, serif";

// Same recover contract as app/error.tsx: 16.3.0 passes the stable `retry`,
// which re-fetches and re-renders the boundary's children, and the docs say to
// prefer it over `reset` (which re-renders without re-fetching). `reset` stays
// as the fallback because this prop was `unstable_retry` until 16.3.0 stabilized
// it (error.md Version History) — on an older runtime the required `retry`
// below would arrive undefined, and a blackout page whose only button is dead
// is worse than one that merely re-renders.
export default function GlobalError({
  error,
  reset,
  retry,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const recover = retry ?? reset;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          background: "#14110f",
          color: "#ece1c9",
          fontFamily: BODY,
        }}
      >
        {/* React <title> — metadata exports are not supported in global-error. */}
        <title>Total Blackout — Cone of Silence</title>
        <section
          style={{
            maxWidth: "32rem",
            width: "100%",
            textAlign: "center",
            border: "1px solid rgba(199, 154, 59, 0.45)",
            background: "#1c1815",
            padding: "2rem",
          }}
        >
          <p
            style={{
              fontFamily: TYPE,
              textTransform: "uppercase",
              letterSpacing: "0.32em",
              fontSize: "0.7rem",
              color: "#d7391f",
              margin: 0,
            }}
          >
            ◈ Total Blackout
          </p>
          <h1
            style={{
              fontFamily: DISPLAY,
              fontSize: "2.75rem",
              letterSpacing: "0.04em",
              lineHeight: 1,
              margin: "0.75rem 0 0",
              color: "#ece1c9",
            }}
          >
            The Station Went Dark
          </h1>
          <p
            style={{
              margin: "0.75rem auto 0",
              maxWidth: "26rem",
              color: "#a99d81",
              lineHeight: 1.6,
            }}
          >
            A failure reached the foundation of the building — even the standing
            fixtures are down. Re-establish the channel to bring the station back
            up.
          </p>
          {error.digest && (
            <p
              style={{
                fontFamily: TYPE,
                textTransform: "uppercase",
                letterSpacing: "0.32em",
                fontSize: "0.7rem",
                color: "#8f8265",
                marginTop: "1rem",
              }}
            >
              Case No. {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={() => recover()}
            style={{
              fontFamily: TYPE,
              textTransform: "uppercase",
              letterSpacing: "0.32em",
              fontSize: "0.7rem",
              marginTop: "1.5rem",
              padding: "0.75rem 1.5rem",
              background: "transparent",
              color: "#a99d81",
              border: "1px solid rgba(143, 130, 101, 0.3)",
              cursor: "pointer",
            }}
          >
            Re-Establish Channel
          </button>
        </section>
      </body>
    </html>
  );
}
