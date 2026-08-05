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
| 4 | Wifi-blip self-heal | Not recorded as a discrete step; disconnect/heal behavior exercised incidentally. See F2. **Closed 8/3:** the in-class four-person test ran it deliberately — wifi drop + rejoin PASS (recorded in `2026-08-04-dress-rehearsal-report.md`) |
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

**F3 — a Mic Cut participant's voice came through the operator's machine
(both co-located seats heard it from the speakers — NOT room acoustics;
corrected from this report's first draft).** Full transmit-path audit
performed same night; the app cannot send audio from a cut mic:

- `toggleMic` disables the audio track objects on the live stream
  (`hooks/useLocalMedia.ts:116-122`); every `PeerLink` sends those same
  objects (`pc.addTrack(track, opts.localStream)`, `lib/webrtc/peer.ts:152`)
  — no `clone()` anywhere in the webrtc path.
- A disabled track makes the browser's sender emit silence at the engine
  level, upstream of the E2EE transform (which only sees encoded frames).
- `switchDevice` stops old tracks (stopped = silent) and new tracks reach
  every link via `session.ts:514-515` → `mesh.replaceStreamAll`; links
  built later (including 4C rebuilds) read the session's current stream
  via the late-bound factory (`lib/webrtc/mesh.ts:310-311`).
- The only second mic capture in the codebase (podcast `recordGraph`) is
  login-gated, exactly-2, local-only — not active in the drill.

Remaining hypothesis: his voice entered through the OTHER live mic in the
room — the operator's, one seat away — reached the remote seats, was
played on an open-speaker seat and re-captured by its mic (echo
cancellation is per-machine and imperfect), and returned to everyone,
including the operator's speakers. His mic being cut is a red herring on
this path; the loop never uses it.

**Discriminator (5 min, 3 seats, two co-located + one remote with
speakers on):** co-located seat A cuts mic and speaks → voice heard
through machines. Then co-located seat B (operator) cuts THEIR mic too →
if the voice vanishes, the echo path is proven and the app is exonerated;
if it persists with both room mics cut, it IS a transmit leak — stop and
capture (webrtc-internals dump on the speaking seat, audio levels on
`outbound-rtp`). If echo is confirmed: consider a drill/call note that
co-located seats need headphones; no code change indicated.

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
