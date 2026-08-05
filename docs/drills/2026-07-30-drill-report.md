# Four-person drill — 2026-07-30 run

First live run. Four volunteer testers filled the four seats; operator
(room creator) not in the call. Network spread: two different wifi
networks plus one phone on cellular.

**Passed:** step 2 (speaking glow visible everywhere), step 3 (airplane-mode
round-trip ~10 s — tile went Signal Lost, then healed unaided), step 5
(force-quit → tile gone for everyone), step 6 (reopening the same invite
link rejoined cleanly). Cross-network and cellular coverage achieved.

**Partial — step 1:** all four seated, but the Ubuntu participant
(non-standard hardware) was media-dead in both directions — login and join
worked, yet he saw/heard no one and no one saw/heard him. The other three
seats were unaffected. No diagnostics captured (browser unknown). OPEN
INVESTIGATION: next run, capture that seat's browser name/version and
`chrome://webrtc-internals` (Firefox: `about:webrtc`) before anything else.

**Failed — step 4 (server restart):** the call never recovered; all four
clients ended on a terminal failure card. Not an infrastructure fault — the
server restarted clean in ~3 s (verified via journalctl and zero live ws
connections after). Root cause: restart recovery depends on the room
creator's browser re-creating the room via create-on-miss
(`lib/webrtc/signaling.ts`); the creation token lives only in that browser's
localStorage. With the creator outside the call, all four clients were
join-only — the 90 s retry window expired and every client went terminal.

**Not reached:** forceTurn pass.

## Findings

- Drill doc now states the hidden requirement: the operator must be one of
  the four, in the browser holding creation clearance.
- Design limitation (recorded, accepted for now): room recovery has a single
  point of failure — the creator's device. If it dies mid-call, the
  remaining peers cannot recover even though the server returns.
- Linux seat media failure is unexplained until diagnostics exist; suspects
  range from codec support to network path — do not guess, measure.

## Linux seat — investigation update (2026-08-03)

Seat identified: Chromium 150.0.7871.128 (snap), Ubuntu 25.10, arm64
(Lenovo Yoga Slim 7x, Snapdragon). Live two-person retest with the operator;
still media-dead. Findings, measured server-side unless noted:

- Camera: getUserMedia `NotFoundError` → app degraded to mic-only as
  designed. No Linux driver for that webcam; permanent for this machine,
  unrelated to the media failure (receiving needs no camera).
- Ruled out: invite-link integrity (fresh links compared identical),
  room mismatch, signaling (both clients' websockets observed connected on
  the droplet), TURN reachability (4 TCP connections from his IP), TURN
  auth (runbook verify + REST-minted creds both allocate; CreatePermission
  traffic in syslog), server room state (operator's two-tab control call
  connected in seconds), the shared wifi (other seats fine on it).
- His ICE candidates include Docker bridge (172.17.0.1), 172.22.0.25, and
  a Tailscale/CGNAT address (100.64.0.16). Tailscale was running;
  `tailscale down` alone did not fix (no reboot tried — tun interface may
  linger).
- Net: signaling and TURN control traffic work from his machine; ICE never
  completes. Everything app- and server-side is exonerated.

Suspended 2026-08-03 (edge-case hardware, diminishing returns). If resumed:
webrtc-internals dump per the operator playbook (ICE state chains +
candidate types), reboot after tailscale down, Firefox A/B on the same
machine.

Two systemic findings from the retest, worth their own tickets:

- Phase 5 proof-gating hides unproven peers, so a transport failure now
  renders as an empty room with no card — the 7/30 symptom (tiles, dead
  media) and tonight's (no tiles) are the SAME failure under different
  frontends. Consider a "proving…" placeholder tile or surfacing proof
  timeout.
- The header shows "Agents present: 1" while status is still "connecting",
  indistinguishable from a successful lonely join.
- Vercel redeploys the frontend on every push; the droplet server deploys
  only by hand — they skewed for days (frontend Phase 5D vs server 7/27).
  Wire protocol happened to be unchanged, so no breakage this time. Deploy
  the server alongside, or pin the frontend, before the next drill.

## Tester feedback (→ Phase 5/6 visual pass; record, don't fix)

- Speaking glow works but is too subtle — thicker ring or brighter glow.
- Testers would rather mute a participant themselves than be told to hit
  Restore Audio — wants a large per-tile MUTE overlay on the video.
  (Per-tile local mute doesn't exist yet; needs design.)
- Mobile: tiles inconsistently shrink / fail to shrink on scroll; top nav
  is wider than the viewport (everything else centers correctly).
- Bottom footprint mark not centered on its line.
- Lighthouse: performance 60 — needs attention.

## Status

Drill NOT passed — full re-run required before the final demo: operator
in-call for step 4, forceTurn pass, and a diagnosed retry of the Linux
seat. Cellular + cross-network coverage already demonstrated.

> **Superseded:** the 2026-08-03 re-run (`2026-08-03-drill-report.md`)
> closed all three gaps and PASSED; the remaining unrecorded step-4 check
> passed in class 8/3 (see `2026-08-04-dress-rehearsal-report.md`).
