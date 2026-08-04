# Four-person drill — 2026-08-03 re-run

Re-run of the 2026-07-30 drill. Four seats, four networks, one cellular
phone; operator seated in-call holding creation clearance (per the
operator-in-call rule). Live site ran same-day deploys: audio-on-join +
local per-person mute (4da1c97) and the 8/3 exchange/signaling fixes.

## Results

| # | Step | Result |
|---|------|--------|
| 1 | All four join | PASS with caveat — one link (operator ↔ seat 4) had no media one-way at first join while the other five links were fine; seat 4's rejoin rebuilt it and all four seats held live media both ways after. See F1 |
| 2 | Speaking glow | Not recorded |
| 3 | Per-person mute | Not recorded (feature shipped same day; no issues volunteered) |
| 4 | Wifi-blip self-heal | Not recorded as a discrete step; disconnect/heal behavior exercised incidentally. See F2 |
| 5 | Server restart, operator seated | PASS — call re-established quickly, no fresh invites. Closes the 7/30 stranding |
| 6 | Force-quit | PASS — tile vanished for everyone |
| 7 | Rejoin same invite | PASS — seat returned |
| 8 | forceTurn relay pass | PASS — all four joined `?forceTurn=1` and everyone heard everyone. Relay-only ICE policy makes a working call sufficient proof; webrtc-internals artifact not captured (call ended first) |

The three gaps left open on 7/30 — a media-dead seat, restart stranding,
and the unreached relay pass — are all closed.

## Findings

**F1 — one-way link at join (operator couldn't see seat 4; everyone else
could).** Single peer-link ICE failure between those two networks; healed
by seat 4's rejoin, and the later relay-only call was clean. NAT-class,
same family as the 7/15 and 7/30 observations; TURN is the remedy and the
mesh's per-link independence contained it. No app defect indicated.

**F2 — a reconnecting seat was inaudible to ALL seats; his own screen
showed Mic Cut (witnessed by the operator, no screenshot).** Not the new
audio-on-join code: audibility failed at the sender. The app never restores
a mic to off across a page reload (`useLocalMedia` starts `micOn: true`
and re-enables tracks on every fresh acquire); mic state deliberately
survives in-call recovery without a reload. So the mic was cut by a click
(his own, possibly in the green room) and nobody noticed the state.
Action → Phase 6: make your-own-mic-is-cut much louder in-call.

**F3 — operator heard a Mic Cut participant speak while sitting next to
him.** With `track.enabled = false` WebRTC transmits silence; no remote
seat reported hearing him. Almost certainly room acoustics from the
co-located seats, not a transmit leak. No action; re-test with separated
seats if it ever recurs.

**F4 — audio-on-join behaved.** Every join on every device was audible
immediately; the "◈ Audio Blocked by Browser" fallback never appeared for
anyone the whole drill.

## Feature request (tester + operator)

In-call device switching — swap camera/mic without leaving and rejoining
(phones especially: front/back camera). Recorded on the Phase 6 design
list. Note for design: `useLocalMedia.switchDevice` already re-acquires
mid-call preserving mute state; the work is in-call UI plus replacing
tracks on every mesh link.

## Follow-ups

- Revoke + purge the drill room-creation token on `/admin`.
- Phase 6: self-mic-cut prominence (F2), in-call device switching.
- Steps 2–4 unrecorded: fold explicit checks into the next scheduled run
  (no dedicated re-run needed).
