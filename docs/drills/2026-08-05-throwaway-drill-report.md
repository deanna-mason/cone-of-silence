# Throwaway-take drill run — 2026-08-05

Deanna + Lily, live site, short disposable take. Server 0.2.0 (droplet
redeployed this morning). Closes the deferred disconnection/resilience drills
from the 8/4 dress rehearsal, including dress-rehearsal steps 24–25.

## Results

| Drill | Result |
|---|---|
| Camera unplug (Continuity Camera) | Alarm fired with correct cause; acknowledged. **PASS** (alarm path) |
| Camera re-attach after replug | **FAIL** — no way to reselect the camera; equipment controls blocked on screen; video stayed dead for the rest of the call (7/31 "unplug limbo / no re-attach path" confirmed live, now with the in-call device bar shipped but unreachable) |
| Partner wifi drop (Lily off → on) | "Signal lost" shown, call recovered. **PASS** (recovery) |
| Post-reconnect audio | **FAIL** — after Lily's reconnect she could no longer hear Deanna (one-way audio loss; Deanna's video was already dead from the unplug drill — possibly related) |
| Transfer interrupt + resume across the wifi drop | Resume delivered every part. **PASS** |
| Browser force-quit + rejoin | **PASS** |
| Server restart mid-recording (step 24) | Both sides showed signal-lost and self-healed fast; tape kept rolling. **PASS** |
| Post-restart episode exchange (step 25) | Delivered fully. **PASS**, with one caveat below |
| Delivered-state surface (8/3 UX note) | "Episode delivered" + "Roll Tape" shown post-delivery — confirmed fixed live |

## Findings

1. **Take-stop lost across the server restart.** After the mid-recording
   restart, Deanna's stop never reached Lily — her side stayed "Reel Rolling."
   Deanna's "Resume Transmission" then silently no-oped (transfers are held
   while a take is active) until Lily cut manually, after which resume worked
   immediately. Needs: take-state re-sync after reconnect, or at minimum the
   card should say *why* resume is blocked ("partner still rolling").
2. **"Transmission Interrupted" card truncates its message** ("The li…") —
   unreadable at the moment it matters most. Redesign approved by Deanna:
   full text must be visible.
3. **Camera re-attach** (table above) — the alarm/acknowledge flow works, but
   there is no recovery path short of leaving and rejoining, and the device
   controls are blocked when they're needed.
4. **One-way audio after partner reconnect** (table above) — reproduce with a
   healthy local stream to separate it from the dead-camera state.

## Status

Disconnection/resilience drills: **run and passed** except the two findings
above (camera re-attach, post-reconnect audio). Neither blocks the demo — both
have the same live workaround (leave and rejoin) — but both are real.

## Fixes shipped 2026-08-05 (all four findings)

Diagnosed from source and fixed the same evening; each carries unit tests.
**None of these has been re-drilled live** — the drill that proves them is
still owed.

1. **Take-stop lost across a restart** — root cause: a restart re-mints every
   peerId, so the pinned partner became a ghost; Cut targeted the ghost, and
   the mid-take pin guard refused the rejoin hello that would have healed it.
   The pin could only heal at take-end, which could never arrive. Fixed two
   ways: `isPeerLive` releases a pin whose partner has left the roster (a
   live partner still can't be clobbered mid-take), and `pod/hello` now
   carries the sender's active takeId, so an orphaned rolling side cuts
   itself. `scheduleStop` is idempotent now, which also hardens the
   pre-existing duplicate-stop path.
2. **Interrupted card truncation** — new wrapping row shape: 3rem at rest,
   grows to a second line rather than ellipsize. Applied to every state whose
   static message is the point; live-telemetry rows keep the fixed height so
   a take never costs tile height under the no-scroll rule. The ledgered
   truncation audit is folded in.
   Also finding 1's second ask: a refused offer is now answered with
   `xfr/busy` instead of silence, and the card says "the other chair is still
   rolling tape" instead of Resume no-oping.
3. **Camera re-attach** — `fault` no longer sits in the device-bar lock (the
   take is already compromised in a fault; a device swap is the remedy), and
   `useLocalMedia` refreshes its device lists on `devicechange`, so a
   replugged camera actually appears. Call controls keep the broad lock.
4. **One-way audio after reconnect** — a rebuilt link was handing the
   unplugged camera's ENDED video track to `addTrack`, where the E2EE
   transform and codec pin can throw and take the already-added audio sender
   down with the whole link; the empty `onnegotiationneeded` catch then left
   it wedged in "connecting", a state the mesh's restart ladder ignores.
   Ended tracks are skipped, and a failed negotiation now reports "failed"
   so recovery engages. Fixing 3 makes this trigger unreachable at source.
