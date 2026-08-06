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

## Re-drill of block F — 2026-08-05, ~6:30 pm. Both fixes PASS

Bundle confirmed in-browser before the run (`faultedThisTake` present in the
loaded scripts), after an earlier attempt was invalidated by a stale one — see
"The stale-bundle lesson" below.

| Fix | Result |
|---|---|
| 2 — device bar reachable for the rest of a faulted take | **PASS** |
| 3 — a device swap adds a sender the link never had | **PASS** |

**Fix 2** proved out by the *fault-cleared* route rather than the acknowledge
route: the camera alarm cleared on its own when the MacBook camera came back,
and the pickers stayed available **for the rest of the rolling take**, with no
"Locked while rolling" notice. Both routes run through the same mechanism —
dismissing sets `dismissedKey`, clearing empties `faults`, and either drops
`faultShown` to false and the panel back to `rolling`. Pre-fix that re-locked
the bar; it did not. The latch holds.

**Fix 3** proved out end to end: with the camera unplugged, Lily dropped wifi
and the call rebuilt the link; Deanna then replugged and picked the iPhone
camera, and **Lily saw her on it with neither side rejoining**. A mic swap
propagated too — Lily heard the change. That is `replaceStream` adding a
sender to a live link and the far side decrypting it, which is exactly what
the unit tests could not prove.

Also of note: the wifi drop **self-healed fast this time**, where the night
before it did not (finding 1 did not reproduce). A "partner went silent" tape
fault appeared during the drop and self-healed. The take survived the whole
sequence and never cut.

### New finding 4 (minor): a replugged camera is auto-*shown* but not auto-*selected*

The replugged iPhone appeared in the camera list and displayed as the selected
option, but the video did not change — Deanna had to re-pick it manually
before it took effect. Same shape as the night before ("it did say iPhone
camera was the picked camera"). The picker's displayed value falls back to
the first device in the list when the stored choice no longer resolves, so the
UI claims a device is selected while the stream is still on another one.
Cosmetic next to the rest, but it is a display that lies, and it cost real
confusion twice.

### The stale-bundle lesson

The first attempt at this re-drill "failed" both fixes. It was run on a bundle
deployed at 5:29 pm — which already carried the pre-roll reminder, so the
obvious sanity check ("did you see the new reminder?") passed while the fixes,
deployed at 5:56 pm, were absent. **A newer-looking UI is not proof of a
current bundle.** Verify from inside the room, before drilling, with a marker
belonging to the change under test:

```js
(async () => {
  const js = performance.getEntriesByType('resource').map(r => r.name).filter(n => n.endsWith('.js'));
  for (const u of js) if ((await (await fetch(u)).text()).includes('MARKER')) return console.log('✅ PRESENT');
  console.log('❌ MISSING — checked ' + js.length + ' scripts');
})()
```

Two further traps found the hard way: the room's code only loads once you are
**in the room**, so the check reads false on the lobby; and DevTools records
no network traffic from before it was opened, so a Network-panel check of the
initial load is worthless unless it was open first.

## D4 (resume → deliver): PASS — 2026-08-05, ~6:40 pm

Owed across **three** drills. The first attempt was eaten by the take-state
bug, the second by the roster desync; this time the mid-transfer wifi drop
parked both sides on a correctly-worded interrupted card, Resume Transmission
picked it up, and the episode delivered in full (Deanna's report).

That also puts a third live sighting on the finding-2a truncation fix, and the
card correctly read "Interrupted" rather than "Held" — the partner was not
rolling, which is exactly the distinction `xfr/busy` exists to draw.

## Owed

1. **Finding 1 (roster desync) — DEFERRED by Deanna, 8/5. Deliberately NOT in
   the final submission; follow-up fix later.** It fired hard once and then
   declined to reproduce across three further wifi drops the same night, and
   the "transfer in flight is the trigger" theory is disproven (it fired once
   without one, and did not fire twice with one). Rare but severe: when it
   hits, the call is dead until someone rejoins — do not let that get
   downgraded to "works fine." No code until the evidence in
   `reconnect-desync-evidence.md` is captured. Workaround for the demo: the
   host who did **not** drop leaves and rejoins.
2. ~~Re-verify Block C's vault parts.~~ **DONE — see below.** (The vault is a
   real picked directory at `~/Documents/Podcast Reel/`, not OPFS; nothing
   needed exporting. An earlier note in this file said otherwise and was
   wrong.)
3. Finding 4 (a replugged camera shows as selected without being selected) —
   **FIXED `fd3f186`, not yet proven live.** The pickers now name the device
   read off the live track rather than stored intent. Turned out to have three
   routes, and the likeliest one was a stale-but-still-resolvable choice
   surviving in `sessionStorage`, not the `?? devices[0]` fallback originally
   suspected. Next drill: with the camera unplugged the picker should read
   "No camera live — select one" rather than "iPhone", and after a replug
   **one** pick should restore video both locally and for the partner.
   Unverified without hardware: whether a Continuity Camera fires `ended` on
   unplug, and whether Chrome's `getSettings().deviceId` for it matches what
   `enumerateDevices()` lists.

## Block C vault verification — 2026-08-06. PASS, with the contract half-proven

Block C is **`take-20260805-2303-fc01`** (vault = `~/Documents/Podcast Reel/`).
Identified from file evidence, not timestamps alone: both local parts are
**exactly 0 bytes** (the empty-string SHA), **neither local sidecar exists**,
and `episode.json` carries `"local": null`. `vault.ts` explains that shape
precisely — `getFileHandle(create:true)` makes the file on first append, but a
`FileSystemWritableFileStream` only commits bytes at `close()`, so a force-quit
leaves a created-but-empty file and no sidecar. That is a crash signature, not
an empty take.

The three sibling takes are each independently explained, which is what makes
the identification safe: `2258-d527` is the Block A/B take (110.16 s, survived
the server restart, cut cleanly both sides); `2306-af41` is the Block D
wifi-kill (local complete with both sidecars, but `remote/` holds audio and no
video and there is no `episode.json` — a transfer that died in flight);
`2314-f0a6` is a complete 182.34 s take that was never sent.

**Lily's side — unambiguous PASS.** Four parts, every SHA-256 matching the
manifest, concatenating in manifest order into 64.14 s that decodes start to
finish with **zero errors and zero warnings**, no PTS discontinuity across the
part boundary, and **both tone marks present** — start onset 0.393 s, end
63.555 s, span 63.163 s, with exactly four beep runs in the whole track and no
spurious or echo beeps. Fix 1b's self-cut ended her reel and left her tape
whole. (Independently re-checked in the parent session: the concatenation
decodes at exit 0.)

**Deanna's side — passes, but vacuously, and this is the part worth knowing.**
Exactly one part per stream was lost and it was the in-flight one, which is the
most the contract allows. But the take ran only ~64 s against a 60 s part
rotation and she force-quit inside the first part, so **zero parts had ever
been committed**. The other half of the contract — *everything committed before
the force-quit survives* — was never exercised here and remains **unproven**.
Proving it needs a force-quit at least two part rotations (>2 min) into a take.
Worth folding into a future drill rather than re-running tonight.

**Bonus finding — the 7/31 missing-start-mark defect does not reproduce.**
Deanna's local audio in all three neighbouring takes carries both marks (starts
at 0.065 s; ends at 109.596 / 69.159 / 181.798 s), each with exactly four
correctly-paired beep runs. Her rig was emitting start marks on 8/5. That
closes a doubt left open since the 7/31 dress rehearsal.

**Housekeeping:** every part file across all four takes hash-verified — 24 of
24, sizes and digests. No `.crswap` leftovers, no gaps in part numbering. One
loose end: `2306-af41/remote/` holds a half-delivered episode (audio, no video,
no manifest) still sitting in the vault.
