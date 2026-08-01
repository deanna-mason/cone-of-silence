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

## Episode exchange drill (Slice 5B acceptance)

Run after `node e2e/phase5b-e2e.js` passes twice headless — this is the
human half of the same acceptance.

| # | Step | Expect |
|---|------|--------|
| 10 | After the take, SEND EPISODE from one Mac | Both sides show a progress row (MB/s + ETA), climbing |
| 11 | Kill the sender's wifi mid-transfer | Both sides show Transmission Interrupted (parked, not an error card) |
| 12 | Restore the sender's wifi | The call recovers; a wifi drop hands out fresh peerIds even on the same room, so Resume Transmission is not offered — Stand Down, then SEND EPISODE again |
| 13 | Watch the resumed transfer | Completes without re-sending any part the receiver already has on disk |
| 14 | Check the receiver's take folder throughout | `episode.json` appears in it only at the very end, after every part has landed |

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
| 17 | Listen to `episode.m4a`, start AND end | Both hosts' tone marks are fused (one clean sync tone each end, not doubled) |
| 18 | Watch `episode.mp4`, start AND end | Lip-sync holds at both ends |
| 19 | Eyeball the dossier backdrop (`template.html`) | Design checkpoint for Deanna — draft aged-dossier look, codename labels, stamp |

Quality-max alternative (rejected for live use): native iPhone 4K capture —
iOS camera exclusivity means the phone can't feed the call while recording,
so no live monitoring.
