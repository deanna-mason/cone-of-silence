# Four-person drill — 2026-07-30 run

First live run. Four volunteer testers on shared wifi, operator (room
creator) not in the call — the four volunteers filled all four seats.

**Passed:** steps 1–3 (2×2 grid, speaking glow, wifi-drop self-heal).

**Failed:** step 4 (server restart). The call never recovered; all four
clients ended on a terminal failure card. Not an infrastructure fault — the
server restarted clean in ~3 s (verified via journalctl and zero live ws
connections after). Root cause: restart recovery depends on the room
creator's browser re-creating the room via create-on-miss
(`lib/webrtc/signaling.ts`); the creation token lives only in that browser's
localStorage. With the creator outside the call, all four clients were
join-only — the 90 s retry window expired and every client went terminal.

**Not reached:** steps 5–6, forceTurn pass, cellular seat.

## Findings

- Drill doc now states the hidden requirement: the operator must be one of
  the four, in the browser holding creation clearance.
- Design limitation (recorded, accepted for now): room recovery has a single
  point of failure — the creator's device. If it dies mid-call, the
  remaining peers cannot recover even though the server returns.

## Status

Drill NOT passed — full re-run required before the final demo, operator
in-call, one phone on cellular.
