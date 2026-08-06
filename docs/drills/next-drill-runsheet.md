# Runsheet — the drill owed as of 2026-08-05 evening

> ## CLOSED — nothing on this sheet is owed. Written 17:57, overtaken by 20:05.
>
> **Marked 2026-08-06.** This sheet was written at 17:57 on 2026-08-05 and both
> of its parts were settled later the same evening. It is kept as the record of
> how that drill was to be run — **do not run it as written, and do not read it
> as an outstanding obligation.**
>
> | This sheet's item | Actual outcome |
> |---|---|
> | **Part 1** — prove findings 2 and 3 live | **PASS, 18:29** (`befad8b`). Device bar stayed reachable for the rest of a faulted take; a device swap added a video sender the rebuilt link never had, and Lily saw it with neither side rejoining. See `2026-08-05-four-fix-redrill-report.md` → "Re-drill of block F". |
> | **Part 2** — capture evidence for finding 1 (roster desync) | **DEFERRED by Deanna, 19:43** (`f56ff44`). Deliberately **not** in the final submission; still an open, un-root-caused bug — see "Known limitation" below. |
> | "Still owed": Block C vault parts | **VERIFIED, 19:59** (`3661802`). Lily's tape whole — four parts, all SHA-256 matching, both tone marks. Deanna's side passes only vacuously (see that report's Block C section). |
> | "Still owed": D4 (resume → deliver) | **PASS, 19:43** (`f56ff44`). Resume Transmission picked up the parked transfer and delivered the episode in full. |
>
> **Known limitation, still open and staying open:** the **reconnect roster
> desync** (finding 1). Rare but severe — when it hits, the two sides disagree
> about who is in the room and the call is dead until someone rejoins. It is
> deferred by the project owner, excluded from this submission, and must not be
> recorded as fixed. Capture playbook: `reconnect-desync-evidence.md`. Demo
> workaround: the host who did **not** drop leaves and rejoins.
>
> **What is genuinely owed after all this** — nothing blocking, and no part of
> it re-runs this sheet:
> 1. Finding 4 (`fd3f186`, 20:05) — pickers now name the camera actually live —
>    is **fixed but not proven live**; fold the check into the next drill.
> 2. The force-quit contract's second half (everything *committed* before a
>    force-quit survives) is still unproven — it needs a force-quit more than
>    two part rotations (>2 min) into a take.
> 3. The finding-1 evidence capture above, whenever Deanna picks it back up.

One sitting, two parts. Deanna + Lily, two Macs, Continuity Camera on
**Deanna's** side.

- **Part 1** proves the two fixes shipped tonight (findings 2 and 3).
- **Part 2** captures evidence for finding 1, which is NOT fixed and must not
  be guessed at.

Part 1 first — Part 2 deliberately ends in a broken call.

> **Changed tonight, by the other session:** the per-take headphones
> declaration is **gone**. Roll Tape no longer asks "headphones or open
> speakers?" and is no longer gated on an answer. Instead, pressing ROLL TAPE
> opens a **pre-roll reminder** (headphones + phones on Do Not Disturb) with
> **Confirm** to roll and **Not Yet** to back out. Only the host who *presses*
> Roll Tape sees it — the other side sees nothing. That gap is known and
> accepted. **Headphones are still mandatory on both of you.** The reminder
> names the rule; it does not enforce it.

---

## Before you start

1. **Headphones on both hosts.** Both iPhones in a Focus / Do Not Disturb,
   cabled. MOTIV Mix closed.
2. **Hard-reload both Macs** (⌘⇧R) on `www.coneofsilence.app`. Tonight's fixes
   only just deployed; a cached bundle drills the old code and proves nothing.
3. `mkdir -p ~/Desktop/drill-evidence`
4. **Instrument both Macs now**, before joining — Part 2 needs it, and if Part
   1 fails I want the same evidence:
   - Open DevTools (⌥⌘I) in the tab you'll run the call in
   - **Console** tab → gear icon → tick **Preserve log**
   - **Network** tab → tick **Preserve log** → click the **WS** filter
   - Leave DevTools open the whole session
5. **Deanna only:** open `chrome://webrtc-internals` in a separate tab and
   leave it open. It only records connections created while it is already
   open — open it now or the dump is empty.
6. **Deanna only:** in a terminal —
   ```
   ssh root@143.110.227.84
   journalctl -u cone-server -f | tee /tmp/desync-$(date +%H%M).log
   ```

Now both join the room.

---

# Part 1 — prove tonight's two fixes

The two fixes only demonstrate together: finding 2 is what lets you **reach**
the camera picker, finding 3 is what makes your pick **reach Lily**. Testing
either alone looks like a failure.

| # | Who | Do this | Expect |
|---|---|---|---|
| 1 | Deanna | Press **ROLL TAPE** | The pre-roll reminder appears (headphones + DND). Lily sees nothing — expected |
| 2 | Deanna | Press **Confirm** | 3-2-1 countdown, then Reel Rolling on **both**. Tone mark audible on both |
| 3 | both | Let it run ~30 s, talk a little | Gauges climbing on both, no fault banner |
| 4 | Deanna | **Unplug the Continuity Camera** (or close the iPhone lid) | Within 3 s: Deanna reads `YOUR CAMERA DROPPED`, Lily reads `<Deanna's codename>: CAMERA DROPPED` |
| 5 | Deanna | **Do NOT acknowledge yet.** Open **Equipment** | Mic + Camera pickers are interactive. *(This half already worked before tonight — it's the baseline)* |
| 6 | Deanna | **Now acknowledge / stand down the alarm** | Banner clears, reel still rolling |
| 7 | Deanna | Open **Equipment** again | **The pickers are STILL interactive.** ← **This is fix 2.** Before tonight, acknowledging re-locked them and this is exactly where you got stuck |
| 8 | Lily | **Wifi OFF, wait for signal-lost on both, then wifi ON** | Call recovers. This rebuilds the link *while Deanna's camera is dead* — which is what creates the bug fix 3 repairs |
| 9 | both | **Talk to each other. Confirm audio BOTH ways** | Each of you can hear the other. *(This is fix 4 from the last drill — re-confirming it survived tonight's changes)* |
| 10 | Deanna | **Replug the Continuity Camera** | It appears in the camera list without rejoining |
| 11 | Deanna | Select it in the picker | You see yourself |
| 12 | **Lily** | **Say out loud whether you can see Deanna — and hold up fingers for her to count** | **Lily sees a real, moving picture.** ← **This is fix 3.** Neither of you rejoins |
| 13 | Deanna | Cut | Both leave Reel Rolling; end tone on both |

**Step 12 is the whole point of Part 1, and "the tile isn't blank" is not a
pass.** Lily must see actual moving video. A sender added without its
encryption transform would look perfect on Deanna's self-view and arrive
frozen or garbled on Lily's side — that is the specific failure I need ruled
out, which is why she counts fingers rather than just saying "yeah I see you."

**If step 7 fails** (pickers locked after acknowledging) → fix 2 didn't work.
Stop, note it, skip to Part 2.

**If step 12 fails** (Lily still can't see you) → fix 3 didn't work. Before
anything else, have **both** of you save a webrtc-internals dump (Deanna) and
your console logs, then note whether Lily *rejoining* restores it like last
time.

---

# Part 2 — capture the reconnect desync (finding 1)

Not fixed, not root-caused. **This is a capture run, not a fix run.** The
trigger is a wifi drop with **an episode transfer in flight** — plain wifi
drops recovered fine, so the transfer is the key ingredient.

Write down the **wall-clock time** at each starred step. Three logs from three
machines only become useful if I can line them up.

| # | Who | Do this | Note the time |
|---|---|---|---|
| 1 | Deanna | Roll a fresh short take (~60 s) — Roll Tape → Confirm — then Cut | |
| 2 | either | **SEND EPISODE** | |
| 3 | Lily | Once the progress row is climbing, **wifi OFF** | ★ |
| 4 | both | Wait for signal-lost / the interrupted card on both | |
| 5 | Lily | **Wifi ON.** Change nothing else. **Neither of you leaves the room** | ★ |
| 6 | both | **Wait a full 60 seconds. Do not refresh, do not leave, do not click** | |
| 7 | both | Write down exactly what each side shows: the agent count, and the card text | ★ |

If it recovers cleanly this time, say so — that is a real result, and it means
the trigger is narrower than "transfer in flight."

## Capture — BEFORE either of you leaves the room

Leaving closes the connection and takes some of this with it.

1. **Deanna, webrtc-internals tab:** scroll to the bottom → expand **Create
   Dump** → tick **Download the PeerConnection updates and stats data** →
   save as `~/Desktop/drill-evidence/webrtc-deanna.txt`
2. **Both Macs:** Network → WS → click the connection → **Messages** sub-tab →
   right-click → **Save all as HAR with content** →
   `~/Desktop/drill-evidence/ws-deanna.har` (Lily: `ws-lily.har`)
3. **Both Macs:** Console tab → right-click → **Save as...** →
   `~/Desktop/drill-evidence/console-deanna.log` (Lily: `console-lily.log`)
4. **Deanna:** Ctrl-C the journalctl, then from your Mac:
   ```
   scp root@143.110.227.84:/tmp/desync-*.log ~/Desktop/drill-evidence/
   ```
5. Lily sends you her two files; put them in the same folder.

---

## What to tell me afterward

1. Part 1: pass/fail for **step 7** and **step 12** specifically, in Lily's own
   words for 12.
2. Part 2: what each side showed at step 7, and the starred times.
3. That `~/Desktop/drill-evidence/` is populated.

## Still owed after this (not tonight) — BOTH CLOSED, see the banner at the top

- ~~Block C's vault parts were never verified — concatenate both sides' parts in
  sidecar order and confirm clean playback with both tone marks. Needs the
  parts exported out of the OPFS vault to disk first.~~ **DONE 2026-08-05 19:59
  (`3661802`).** Lily's four parts hash-verify and concatenate clean with both
  tone marks. (The "export out of OPFS first" note was wrong — that vault is a
  real picked directory at `~/Documents/Podcast Reel/`.) One half of the
  force-quit contract remains unproven; see the banner.
- ~~D4 (resume → deliver) never ran.~~ **PASS 2026-08-05 19:43 (`f56ff44`).**
