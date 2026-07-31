# Four-person call drill

Re-run before the final demo. Needs 4 people / 4 devices / 4 networks, at
least one phone on cellular. One person is the operator (has ssh to the
droplet).

**The operator must be one of the four, in the browser holding creation
clearance** (`cos-create-token` in localStorage — the browser that opened the
`#create=` link). Step 4's recovery works by that browser re-creating the
room; with the creator outside the call, restart strands everyone (learned
2026-07-30, see `2026-07-30-drill-report.md`). A fifth volunteer is the
at-capacity test, not a seat.

| # | Step | Expect |
|---|------|--------|
| 1 | All four join one invite | Everyone sees/hears everyone (2×2 grid, no scrolling on phones) |
| 2 | One person talks | Brass glow on their tile everywhere else |
| 3 | One phone: wifi OFF for ~10 s, then back ON | Their tile shows ◈ Signal Lost after ~3 s, then heals on its own |
| 4 | Operator: `ssh root@143.110.227.84 systemctl restart cone-server` | "Signal lost — re-establishing…", then the call returns within ~90 s, no fresh invites |
| 5 | One person force-quits the browser | Their tile disappears for everyone within ~1 min |
| 6 | That person re-opens the invite | They're back in the call |

Also note (first real phone pass): landscape layout, tile labels after
someone leaves. Cosmetic findings go to the Phase 5/6 visual pass — record,
don't fix.
