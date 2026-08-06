# Podcast dress rehearsal (Slice 5A acceptance)

> **Corrected 2026-08-06.** Two things this sheet described were overtaken by
> the evening of 2026-08-05 and have been rewritten in place (checklist 5, E2,
> step 1, step 12):
>
> - `ab051eb` **retired the per-take headphones declaration.** Roll Tape is no
>   longer gated and no longer asks "Headphones In / Open Speakers" — those
>   labels are gone. Pressing ROLL TAPE now opens a **pre-roll reminder**
>   (headphones + Do Not Disturb) confirmed with **Roll It** or dismissed with
>   **Not Yet**, seen only by the host who pressed it. **Headphones are still
>   mandatory on both hosts** — they remain the only thing that prevents echo.
>   The app reminds; it does not enforce.
> - Drill D4 proved **Resume Transmission** does pick up a transfer after a
>   wifi drop and deliver it in full (`2026-08-05-four-fix-redrill-report.md`,
>   "D4 (resume → deliver): PASS"). Step 12's old "Resume is not offered" claim
>   was wrong.

Re-run after Task 10 lands, and before any future recorder change ships. Two
Macs, two real rigs (camera + mic, Continuity Camera included), both hosts
logged in. Run this after `node e2e/phase5a-e2e.js` passes twice headless —
this is the human half of the same acceptance.

## Pre-take checklist

| # | Check |
|---|-------|
| 1 | Both iPhones in Do Not Disturb / a Focus. An incoming call steals the Continuity Camera out from under the take — observed live, 7/30. |
| 2 | Both phones cabled to their Mac (reliability + charge, not just the wireless handoff). |
| 3 | MOTIV Mix closed on both machines. |
| 4 | Mic meters peak ≈ -12 on both sides before ROLL TAPE. |
| 5 | **Headphones on BOTH hosts** — this is the only thing that prevents echo, and the pre-roll reminder names it before every take. Nothing enforces it: the app cannot protect a tape recorded on open speakers, because the browser refuses a second capture of an in-call mic its own echo canceller (measured 8/5), so a speakers host records the other host's voice off their own speakers and no later stage removes it. Put the headphones on; there is no in-app remedy. The 8/4 rehearsal echo was exactly this. |

## Echo discriminator (F3, 2026-08-03 drill) — run BEFORE the 40-minute take

Proves whether the 8/3 "cut mic still audible" ghost was an echo loop or a
real transmit leak (the code audit exonerated the transmit path — see
`2026-08-03-drill-report.md` F3). Needs the two Macs co-located plus ONE
extra seat in another room with speakers ON, no headphones (a phone on
cellular is ideal). Ordinary call, ~5 minutes.

| # | Step | Expect |
|---|------|--------|
| E1 | Host A cuts their mic and talks | The ghost reproduces: A's voice comes back through the machines after a beat |
| E2 | Host B cuts their mic too (both room mics cut); A keeps talking | Machines go silent → echo loop proven, app cleared. Co-located seats wear headphones from here on (and for the take: open speakers would bleed call playback onto the raw tapes). A host who genuinely cannot wear headphones should say so out loud before ROLL TAPE — the app has no way to ask, and no way to fix it; that take is compromised by definition |
| E3 | Only if E2 still carries A's voice | STOP — real transmit leak. `chrome://webrtc-internals` on A's Mac → Create dump; do not proceed to the take; report |

**Limit of this gate (learned 8/4):** it clears the *call*, not the *tape*.
The call path runs browser echo cancellation, so speaker bleed can be
inaudible during E1–E3 yet still land on the raw recordings — the recorder
captures the unprocessed mic (DSP deliberately off). A passing gate does NOT
make open speakers safe for a take. **Headphones on both hosts, always, while
rolling.** (Proof: the 8/4 take's raw tape carried a second faint start tone
~490 ms late — a speaker→mic copy the call never surfaced.)

| # | Step | Expect |
|---|------|--------|
| 1 | Both hosts join one call, Tape Vault chosen on each, **headphones physically on both** | Roll Tape armed on both. It is ungated — nothing in the app checks the headphones, so this one is on you |
| 2 | Either host hits ROLL TAPE, reads the pre-roll reminder, and confirms with **Roll It** | The reminder (headphones + Do Not Disturb) appears only on the pressing host's screen — the partner sees nothing until the countdown; **Not Yet** backs out with no take started. On Roll It: 3-2-1 countdown, both machines; tone mark audible on both at zero |
| 3 | Let the take run ≥10 minutes | Reel Rolling on both, gauges climbing, no fault banner |
| 4 | While rolling, check your own self-view against what the tape will hold | The self-view is the FULL letterboxed frame — the whole recorded picture, nothing cropped away. It is displayed MIRRORED while the tape is not; that is orientation only. This is a framing check, not an orientation one — confirm nothing is being cut off, and ignore the flip |
| 5 | Unplug the Continuity Camera (or close its iPhone lid) mid-take | Both sides alarm within 3 s. The unplugged host reads `YOUR CAMERA DROPPED`; the partner reads `<that host's codename>: CAMERA DROPPED` — side AND cause, not a generic "reports a fault" |
| 6 | Coordinated stop | Stopping, then Roll Tape armed again on both; end tone audible on both before the cut |
| 7 | Concatenate each host's part-files in numeric order (sidecar order) | Plays back clean start to finish; both tone marks present |
| 8 | Mid-take, force-quit the browser on one host | At most the in-flight part is lost — concatenate that host's committed parts and confirm nothing earlier is missing |
| 9 | Relaunch, re-open the invite, re-grant the Vault when Chrome prompts | Vault re-grant flow completes; a fresh ROLL TAPE is available |

## Episode exchange drill (Slice 5B acceptance)

Run after `node e2e/phase5b-e2e.js` passes twice headless — this is the
human half of the same acceptance.

| # | Step | Expect |
|---|------|--------|
| 10 | After the take, SEND EPISODE from one Mac | Both sides show a progress row (MB/s + ETA), climbing |
| 11 | Kill the sender's wifi mid-transfer | Both sides show Transmission Interrupted (parked, not an error card) |
| 12 | Restore the sender's wifi | The call recovers and **Resume Transmission** is offered — press it; the parked transfer picks up where it stopped (proven in drill D4, 8/5 evening). If the two sides come back disagreeing about who is in the room, that is the deferred reconnect roster desync, not a transfer bug: the host who did *not* drop leaves and rejoins, then SEND EPISODE again |
| 13 | Watch the resumed transfer | Completes without re-sending any part the receiver already has on disk |
| 14 | Check the receiver's take folder throughout | `episode.json` appears in it only at the very end, after every part has landed |

Commit acceptance: part files must visibly land in the receiver's take
folder (`remote/`) while the transfer runs — a `commit:` fault on the very
first part is the real-vault commit regression class the 2026-08-03 drill
caught (`move()` is OPFS-only; real vaults take the copy fallback).

Honest-throughput note: the sender's own uplink bounds the whole transfer —
expect roughly 20 minutes for 3 GB at a 20 Mbps upload, not the LAN speed
between the two Macs.

## Full dress rehearsal — 40 minutes (5C-time)

Run after `node e2e/darkroom-e2e.js` passes twice headless — this is the
human half of the same acceptance. Repeat the take drill above end to end as
a single 40-minute take, exchange the episode (Slice 5B drill), then:

| # | Step | Expect |
|---|------|--------|
| 15 | On the receiving Mac, start `npm run darkroom -- --vault <vault> --own-codename <yours>` | It watches the vault hands-off — no `--develop` flag, no manual trigger |
| 16 | Wait for the manifest to complete | The darkroom fires on its own and develops the episode |
| 17 | Listen to `episode.m4a`, start AND end | The sync tone itself is EXPECTED to be faint or inaudible (the noise-suppression stage removes it, same as it removes hiss — this is provenance, not a listening cue). Judge alignment by SPEECH instead: no doubling/flam/echo of either host's voice at either end |
| 18 | Watch `episode.mp4`, start AND end | Lip-sync holds at both ends |
| 19 | Eyeball the dossier backdrop (`template.html`) | Design checkpoint for Deanna — draft aged-dossier look, codename labels, stamp |

Quality-max alternative (rejected for live use): native iPhone 4K capture —
iOS camera exclusivity means the phone can't feed the call while recording,
so no live monitoring.

## E2EE drills (Slice 5D acceptance)

Run after `node e2e/phase5d-e2e.js` passes twice headless — this is the human
half of the same acceptance. Two Macs, both hosts on the SAME invite link.

| # | Step | Expect |
|---|------|--------|
| 20 | Hold a call, open `chrome://webrtc-internals` on either Mac | Selected outbound and inbound video codec is VP9 |
| 21 | On each Mac, look at the OTHER host's remote video tile, and in `chrome://webrtc-internals` watch the inbound video stream's `framesDecoded` counter for ~10s | The remote tile shows live motion (not a frozen or black frame) and `framesDecoded` is actively climbing — a normal double-check alongside step 20's codec selection. If a call is connected with VP9 selected but the tile is black/frozen and `framesDecoded` is stuck, the encrypted-media transform is failing on that browser — report it |
| 22 | Paste the invite link into a THIRD browser/profile, but hand-edit the `s=` fragment to any OTHER 22-character base64url value (characters A–Z, a–z, 0–9, `-`, `_` only — a non-base64url character sends you down a different, unrelated failure path and is not this drill) before opening it | That browser shows "The Room Refused Your Papers" (◈ Countersign Rejected) — never a tile, never counted in "Agents present" |
| 23 | Watch the two original hosts while step 22 happens | Neither shows any card or interruption — the call continues exactly as before |
| 24 | Restart the signaling service (or, on a dev box, kill/respawn per the RUNBOOK) mid-call | Both sides show "Signal lost — re-establishing…", then recover: video and audio resume automatically, no fresh invite needed |
| 25 | Exchange a short episode after the restart in step 24 | Transfer completes; the receiving Mac's part hashes verify (Slice 5B drill) |

## Studio Home standing-room note (flow B)

The pinned Studio room (Studio Home's "Enter the Studio", or the green-room
"Pin as my Studio") is a *standing* room: the same roomId/secret every time.
A standing room only lives server-side while at least one host is seated — once
the room empties, the switchboard strikes it. So the FIRST host to walk back in
is re-CREATING the room server-side, which needs a room-creation clearance
(`cos-create-token`) on that device. Without it that host gets ◈ Clearance
Refused, and the second host then finds a dark corridor.

Practical rule: **both hosts should hold creation grants** on the device they
use to enter the standing room — don't rely on one host always being first in.

**Transfer of Custody is UX, not a security boundary.** The "Hand off to another
device" affordance reveals the studio's invite link with a "burns in 5:00"
countdown. That countdown only *hides the link locally* when it runs out — it is
a convenience, NOT a server-enforced one-time use or revocation. The invite link
is a bearer capability from the moment it exists; anyone who copied it keeps
access regardless of the clock. Treat the handoff link like any other invite.


