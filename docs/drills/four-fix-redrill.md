# Four-fix re-drill (2026-08-05 findings)

The drill owed by `2026-08-05-throwaway-drill-report.md`. Four findings were
diagnosed from source and fixed the same evening, each with unit tests; **none
has been proven live.** This card proves them, in one sitting, on the real
site.

Two Macs, two rigs, Deanna + Lily, headphones on both (the 8/4 rule — the
declaration is a warning, not a remedy). Continuity Camera on at least
Deanna's side, since two blocks unplug it.

Each block names the **pre-fix symptom** as well as the expected result. A
block only passes if you see the new behavior — "nothing bad happened" is not
a pass when the old symptom needed a specific trigger to appear.

## Pre-flight

| # | Check | State |
|---|---|---|
| P1 | Unit tests for the four fixes green | **Done 8/5** — 128/128 across `take-protocol`, `podcast-panel`, `use-episode-exchange`, `use-local-media`, `peer-dead-track` |
| P2 | Production carries the fixes | **Done 8/5** — Vercel Production = `8d263a6`, status success. All four fixes are client-side; the droplet was not touched by them |
| P3 | **Both hosts hard-reload** `www.coneofsilence.app` (⌘⇧R) before joining | A cached bundle drills the old code and proves nothing |
| P4 | Deanna has a terminal open with `ssh root@143.110.227.84` live | Block B restarts the signaling service mid-take |
| P5 | iPhones in a Focus, cabled; MOTIV Mix closed; mic meters ≈ -12 | Standard pre-take (see `podcast-dress-rehearsal.md`) |

---

## Block A — Take #1, short

| # | Step | Expect |
|---|---|---|
| A1 | Both join one call, Tape Vault chosen, headphones declared on each | Roll Tape armed on both |
| A2 | ROLL TAPE, let it run ~90 s | Reel Rolling on both, gauges climbing |

Leave it rolling — Block B happens underneath this take.

---

## Block B — Fix 1a: take-state re-sync across a signaling restart

The original finding: a restart re-mints every peerId, so Deanna's pinned
partner became a ghost, her Cut targeted the ghost, and Lily's reel kept
rolling with no way to stop it.

| # | Step | Expect | Pre-fix symptom |
|---|---|---|---|
| B1 | While the reel rolls, on the droplet: `systemctl restart cone-server` | Both sides show signal-lost, then self-heal within a few seconds. Tape keeps rolling on both | (same — this part already passed 8/5) |
| B2 | Wait for both sides to show reconnected | Reel Rolling still on both | |
| B3 | **Deanna hits Cut** | **Both** sides leave Reel Rolling → Stopping → armed again. End tone audible on both | Lily stayed "Reel Rolling" forever; only a manual cut on her side ended it |
| B4 | Concatenate Deanna's parts and Lily's parts in sidecar order | Both play clean start to finish; both tone marks present | |

**Records finding 1's `isPeerLive` path** — the ghost pin released, so Cut
reached a live peer.

---

## Block C — Fix 1b: the orphan self-cut

The second mechanism: `pod/hello` now carries the sender's active takeId, so a
side rolling alone hears a hello naming no take and cuts itself.

| # | Step | Expect | Pre-fix symptom |
|---|---|---|---|
| C1 | Roll a fresh take. Let it reach Reel Rolling on both (past the 3 s countdown — the self-cut is deliberately gated until then) | Rolling on both | |
| C2 | **Deanna force-quits her browser** (⌘⌥Esc), leaving Lily rolling | Lily briefly shows signal-lost, still Reel Rolling | |
| C3 | Deanna relaunches, re-opens the invite, re-grants the Vault, rejoins | On rejoin, **Lily's side cuts itself** — Reel Rolling ends without her touching anything, and her committed parts are intact | Lily rolled indefinitely; only a manual cut stopped her |
| C4 | Check Lily's vault | Her parts through the force-quit are committed and concatenate clean | |

> Deanna's own in-flight part is expected to be lost — that is the standing
> force-quit contract from the dress rehearsal (step 8), not a finding.

---

## Block D — Fix 2a: the interrupted card reads in full

The original finding: the card read `Transmission Interrupted The li…` —
unreadable at the moment it mattered most.

| # | Step | Expect | Pre-fix symptom |
|---|---|---|---|
| D1 | After a take, SEND EPISODE from one Mac | Progress row on both, MB/s + ETA climbing | |
| D2 | Kill the **sender's** wifi mid-transfer | Both sides show the interrupted card. Read it out loud: **"◈ Transmission Interrupted — The line dropped mid-reel. Committed parts are safe in the vault."** — the whole sentence, wrapping to a second line if it needs to. No ellipsis anywhere | `The li…` |
| D3 | Photograph the card on both machines at the narrowest window each will realistically use | Nothing clipped; the panel grows a line rather than truncating, and the page still does not scroll | |
| D4 | Restore wifi, hit Resume Transmission | Transfer resumes and delivers every part; "Episode delivered" + Roll Tape shown after | |

While you are here, sweep the other panel states that carry a static message
(armed, fault, delivered) at the same window width — the truncation fix was
applied across all of them, and this is the only pass that checks them live.

---

## Block E — Fix 2b: "Transmission Held" *(best-effort — may be unreachable)*

A refused offer is now answered with `xfr/busy` and the card says why, instead
of Resume silently no-oping.

**Read this before attempting.** The refusal needs one side rolling while the
other is not — and that state existed *because* of finding 1. Now that Block B
and Block C heal it automatically, this card may be unreachable live by
design. A refused roll is quietly ignored and the proposer's countdown
unwinds, so you cannot stage it by having one host decline to roll.

| # | Step | Expect |
|---|---|---|
| E1 | Repeat C1–C2 (Deanna force-quits mid-take, Lily rolling) | Lily rolling alone |
| E2 | Deanna rejoins and, in the seconds **before** Lily's side self-cuts, hits Resume on a parked transfer | If you win the race: **"◈ Transmission Held — The other chair is still rolling tape. Resume once they cut."** |
| E3 | If the self-cut wins the race every time | Record as **unreachable live — healed at source by fix 1**, unit-test-covered only. That is an acceptable outcome, not a failure |

Do not spend more than two attempts here.

---

## Block F — Fixes 3 + 4, in one take

These two are entangled: the one-way audio came from the dead camera's ENDED
video track being handed to a rebuilt link. **Run F in order** — Fix 4's
trigger only exists while the camera is still unplugged, so do not reselect a
camera until F5.

| # | Step | Expect | Pre-fix symptom |
|---|---|---|---|
| F1 | Roll a take. Mid-take, Deanna unplugs the Continuity Camera | Both alarm within 3 s. Deanna reads `YOUR CAMERA DROPPED`; Lily reads `<Deanna's codename>: CAMERA DROPPED`. Acknowledge | (this already passed 8/5) |
| F2 | **Leave the camera unplugged.** Lily drops her wifi (off → on), let the call recover | "Signal lost", then recovery | |
| F3 | **Both hosts talk.** Check audio in both directions, explicitly | **Two-way audio survives the reconnect** — Lily can still hear Deanna | Lily could no longer hear Deanna at all; one-way audio loss for the rest of the call |
| F4 | If audio is one-way: stop and capture `chrome://webrtc-internals` → Create dump on **both** Macs before doing anything else | The connection state is the tell — pre-fix it wedged in `connecting`, which the restart ladder ignores | |
| F5 | Still in the fault, Deanna opens the **device bar** | The device bar is **reachable** during the fault — mic and camera pickers respond. Call controls stay locked (that is intended) | Every device control was locked; no path but leave-and-rejoin |
| F6 | Deanna replugs the Continuity Camera and opens the camera picker | The replugged camera **appears in the list** without rejoining | The list was frozen at join time; the replug never showed up |
| F7 | Deanna selects it | Video returns — for Deanna and for Lily — inside the same call | Video stayed dead for the rest of the call |
| F8 | Cut, and concatenate Deanna's parts | The parts covering the dead-camera stretch are intact; the swap did not corrupt the reel | |

---

## Results

Fill this in live; it becomes the report.

| Fix | Block | Result |
|---|---|---|
| 1a — take-state re-sync (ghost-pin release) | B | |
| 1b — orphan self-cut on hello | C | |
| 2a — interrupted card reads in full | D | |
| 2b — "Transmission Held" | E | |
| 3 — camera re-attach path | F5–F7 | |
| 4 — two-way audio after reconnect | F2–F3 | |

Anything that fails: capture the card verbatim (photo), note which side saw
it, and grab a `chrome://webrtc-internals` dump on both machines before
leaving the call.
