// Studio Home — the dormant half of "Standing Orders". Renders in the same
// slot as components/StandingOrders.tsx when the host has NOT pinned a room.
//
// Why this exists (2026-08-05 review, defect 2): the pin was reachable only
// from a green room, which is reachable only from an invite link, and /studio
// — the page that hosts the result — said nothing about the feature until
// after you had already used it. A closed loop with no entrance; the host who
// BUILT it could not remember what it did. This card is the entrance.
//
// Explanatory only, deliberately: pinning genuinely cannot be done from this
// page (it needs a room, which does not exist yet), so a call-to-action here
// would have nowhere to go. It names the exact green-room wording instead, so
// the instruction matches the label the host will actually see.

export default function NoStandingStudio() {
  return (
    <section className="hairline border border-dashed bg-inset p-6">
      <div className="flex items-center justify-between">
        <p className="kicker text-ink-soft">Standing Orders</p>
        <p className="kicker text-ink-faint">No Post</p>
      </div>

      <h2 className="mt-2 font-display text-4xl tracking-[0.04em] text-ink-soft">
        No Standing Studio
      </h2>

      <p className="mt-4 font-body text-ink-soft">
        Pin a room as your standing studio and it waits for you here — walk back in from this page
        any time, with no invite link to dig up.
      </p>

      <p className="mt-3 font-body text-sm italic text-ink-soft">
        From any room&rsquo;s green room, choose &ldquo;Make this my standing studio.&rdquo;
      </p>
    </section>
  );
}
