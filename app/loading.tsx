// Root route-segment loading state (Suspense fallback while a page streams
// in). Renders inside the root layout, so it is just the inner strip — the
// same form as the Studio Deck warm-up fallback in app/room/page.tsx.
export default function Loading() {
  return (
    <div role="status" className="hairline flex h-12 items-center gap-3 border bg-inset px-4">
      <p className="kicker shrink-0 text-ink-soft">◈ Switchboard</p>
      <p className="font-body text-sm text-ink-soft">Patching you through…</p>
    </div>
  );
}
