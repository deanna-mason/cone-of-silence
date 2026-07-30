# Podcast dress rehearsal (Slice 5A acceptance)

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

## Take drill

| # | Step | Expect |
|---|------|--------|
| 1 | Both hosts join one call, Tape Vault chosen on each | Roll Tape armed on both |
| 2 | Either host hits ROLL TAPE | 3-2-1 countdown, both machines; tone mark audible on both at zero |
| 3 | Let the take run ≥10 minutes | Reel Rolling on both, gauges climbing, no fault banner |
| 4 | While rolling, check your own self-view against what the tape will hold | The self-view is the FULL letterboxed frame — the whole recorded picture, nothing cropped away. It is displayed MIRRORED while the tape is not; that is orientation only. This is a framing check, not an orientation one — confirm nothing is being cut off, and ignore the flip |
| 5 | Unplug the Continuity Camera (or close its iPhone lid) mid-take | Both sides alarm within 3 s. The unplugged host reads `YOUR CAMERA DROPPED`; the partner reads `<that host's codename>: CAMERA DROPPED` — side AND cause, not a generic "reports a fault" |
| 6 | Coordinated stop | Stopping, then Roll Tape armed again on both; end tone audible on both before the cut |
| 7 | Concatenate each host's part-files in numeric order (sidecar order) | Plays back clean start to finish; both tone marks present |
| 8 | Mid-take, force-quit the browser on one host | At most the in-flight part is lost — concatenate that host's committed parts and confirm nothing earlier is missing |
| 9 | Relaunch, re-open the invite, re-grant the Vault when Chrome prompts | Vault re-grant flow completes; a fresh ROLL TAPE is available |

## Full dress rehearsal — 40 minutes (5C-time)

Not run yet — the darkroom (5C) has to exist first to make 40 minutes of
tape worth generating. Repeat the take drill above end to end as a single
40-minute take once 5C lands, and confirm the darkroom picks up the episode
manifest and processes it.
