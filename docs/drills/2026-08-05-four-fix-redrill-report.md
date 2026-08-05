# Four-fix re-drill run — 2026-08-05 (evening)

Deanna + Lily, live site, Vercel Production `8d263a6`. The drill owed by
`2026-08-05-throwaway-drill-report.md`, run from `four-fix-redrill.md`.

Four of the six proofs landed. One is unreachable by design (as predicted).
**One fix did not work**, and the drill turned up **two new findings** — one of
them demo-threatening.

## Results

| Fix | Block | Result |
|---|---|---|
| 1a — take-state re-sync (ghost-pin release) | B | **PASS** — restart mid-take, both sides self-healed, Cut ended the reel on **both** simultaneously |
| 1b — orphan self-cut on hello | C | **PASS** — force-quit, rejoined, Lily's side cut itself on reconnect without her touching anything |
| 2a — interrupted card reads in full | D | **PASS** — full message readable, no ellipsis |
| 2b — "Transmission Held" | E | **Not attempted** — both sides now heal too fast to win the race. Matches the card's predicted "unreachable live, healed at source by fix 1." Unit-test-covered only |
| 3 — camera re-attach path | F5–F7 | **FAIL** (see finding 2). Its *second* half — live device lists — **PASS**: the replugged camera appeared without rejoining |
| 4 — two-way audio after reconnect | F2–F3 | **PASS** — camera unplugged, Lily dropped wifi, and after recovery both could still hear each other. The original one-way audio loss did not reproduce |

Outstanding: D4 (resume → deliver) never ran — new finding 1 broke the call
first. Block C's vault parts are not yet verified (see "Owed" below).

## New findings

### 1. A wifi drop mid-transfer leaves the two sides disagreeing about the room

**Severity: demo-threatening** — the call did not recover on its own, and the
only fix was for the host who *never left* to leave.

Lily dropped wifi during the transfer; Deanna saw signal-lost, then the
interrupted card (as designed). When Lily turned wifi back **on** — without
leaving the room — the two sides came back with contradictory views:

- **Lily:** one agent in the room, and Deanna's line reported cut.
- **Deanna:** two agents present, Lily's picture frozen, no audio or video.

Neither side recovered. Deanna left and rejoined via the `/studio` pinned-room
nav and found Lily still sitting in the room — Lily had never left.

This is the *call-layer* twin of the bug fix 1a just fixed in the take layer:
a reconnect re-mints the peer id, one side keeps a link to the ghost, and the
rosters diverge. Fix 1a repaired the take protocol's pin; nothing repaired the
mesh's.

**Not yet root-caused — do not guess at it.** The asymmetry (Deanna retained a
stale Lily, Lily never saw Deanna at all) is not explained by the client
source alone, and the honest next step is evidence, not a patch: re-run this
one step with `journalctl -u cone-server -f` open on the droplet and
`chrome://webrtc-internals` on both Macs, and capture the roster the server
actually sends each side on Lily's rejoin.

Note this did **not** reproduce in blocks B or F, where wifi drops recovered
cleanly. The distinguishing condition is an episode transfer in flight.

### 2. Acknowledging the camera alarm re-locks the device bar

**This is why fix 3 failed live.** Root-caused in source; the fix's premise was
right and its trigger condition was wrong.

Observed: with the camera unplugged mid-take, Deanna could open Equipment and
see the list but not interact with it. After she **stopped recording**, the
picker worked immediately.

The panel is only in `fault` while the banner is *undismissed*
(`hooks/usePodcastTake.ts:703`):

```
faultShown = visibleFaults.length > 0 && faultKey(visibleFaults) !== dismissedKey
```

`onDismissFault` sets `dismissedKey` (line 805). So acknowledging the alarm
drops `faultShown` to false, and `derivePanel()` falls straight through to
`kind: "rolling"` (line 715). In `app/room/page.tsx`, `takeInProgress` is then
true again and the device bar re-locks (line 553).

Fix 3 unlocks the bar **only while the alarm banner is still on screen**. The
drill card told Deanna to acknowledge at F1 — so she acknowledged, and locked
herself back out. Stopping the take cleared `takeInProgress`, which is exactly
why the picker came alive at that moment.

The fix's stated intent — "in a fault the take is already compromised and a
device swap is the remedy" — should key on *a fault having occurred during
this take*, not on the banner currently being visible.

### 3. A link built without a video sender can never gain one

**This is why the camera never came back for Lily**, and it is a regression
introduced by fix 4.

Observed: after the replug, Deanna selected the iPhone camera (it was already
the default) — no video for Lily. She stopped recording, switched to the
MacBook camera — **she could see herself**, Lily still could not. Switched
back to the iPhone camera — she could see herself again, Lily still could not.
Lily left and rejoined; Lily could see her immediately. Deanna never left.

Deanna's read that the Continuity Camera hadn't re-armed on the phone is a
good catch but is ruled out by her own next step: the MacBook camera produced
a working local self-view that Lily still never received. Local capture was
fine throughout; the track was not reaching the peer.

`replaceStream` (`lib/webrtc/peer.ts:248`) only swaps tracks on senders that
already exist:

```
for (const sender of this.pc.getSenders()) {
  const kind = sender.track?.kind;
  if (!kind) continue;
  await sender.replaceTrack(...);
}
```

It never *adds* a sender — and `attachSenderTransform`'s own comment states
the rule: "Senders are only ever created here (construction's addTrack loop)."

Fix 4 made construction skip ended tracks. So the link Lily rebuilt on
reconnect — built while Deanna's camera was unplugged and its video track
ended — has **no video sender at all**. Every later camera pick calls
`replaceStream`, which finds no video sender and silently does nothing.
Rebuilding the link is the only recovery, which is precisely why *Lily*
rejoining fixed it and Deanna's switching never did.

Fix 4 traded a hard failure (the ended track took the whole link down, killing
audio) for a silent one (video is permanently absent on that link). The audio
half is genuinely fixed and proven — F3 passed. The video half is worse than
before in one respect: it now fails quietly.

The 8/5 note that "fixing 3 makes this trigger unreachable at source" does not
hold, because fix 3 did not work (finding 2).

## Fixes shipped for findings 2 and 3 (same evening)

Both were confirmed in source, so both were fixed the same night, each with
unit tests and a red-green check. **Neither has been proven live** — the
re-drill that proves them is now owed, exactly as the four before them were.

- **Finding 2** (`dc509d0`) — `usePodcastTake` latches `faultedThisTake` for
  the whole take, keyed on the faults themselves rather than on the banner
  being visible; the device bar keys on that latch. Acknowledging the alarm
  no longer re-locks the bar. `CallControls` keeps the broad lock.
- **Finding 3** (`d73d06a`) — `replaceStream` now adds a sender for any live
  track whose kind the link has none of, through a single `addLocalTrack`
  funnel shared with construction so the E2EE transform and VP9 pin cannot
  diverge between the two paths. 85ebec6's ended-track guard now holds on the
  swap path too, and a nulled sender remembers what it was for so it can be
  re-populated rather than stranded.

Finding 3's fix also covers a second route to the same defect that the drill
did not hit: `getLocalStream`'s audio-only fallback produces the same
missing-video-sender shape with no unplug involved.

**Finding 1 is deliberately untouched** — still un-root-caused, pending the
capture in `reconnect-desync-evidence.md`.

## Owed

1. Capture and root-cause finding 1 (`reconnect-desync-evidence.md`). No code
   until the evidence is in.
2. **Live re-drill of block F**, which now proves findings 2 and 3 together.
   They are entangled in the other direction: finding 2 is what lets the
   operator *reach* the camera picker, and finding 3 is what makes the pick
   actually reach the partner. Neither can be demonstrated without the other.
   Run F5 **both ways** — alarm acknowledged and alarm still on screen — since
   acknowledging is what defeated it last time. The pass condition for F7 is
   that the partner sees a **real picture**, not a frozen or garbled tile: a
   sender added without its E2EE transform would look correct locally and fail
   only on the far side.
3. Re-verify Block C's vault parts: concatenate Deanna's and Lily's parts in
   sidecar order and confirm both play clean with both tone marks. Needs the
   parts exported out of the OPFS vault to disk first.
4. Re-run D4 (resume → deliver) once finding 1 is resolved.
