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
| 1 | All four join one invite | Everyone sees AND hears everyone immediately — no clicks (2×2 grid, no scrolling on phones). A center "◈ Audio Blocked by Browser / Restore Audio" panel is the fallback, not a bug: click it once, note that seat's browser/OS |
| 2 | One person talks | Brass glow on their tile everywhere else |
| 3 | Everyone mutes one other person (corner Mute), then unmutes | Muter alone stops hearing them (the muted person still hears everyone); tile dims with ◇ Muted — Unmute; unmute restores |
| 4 | One phone: wifi OFF for ~10 s, then back ON | Their tile shows ◈ Signal Lost after ~3 s, then heals on its own. If anyone had them muted, they return audible (reconnect resets mute — by design) |
| 5 | Operator: `ssh root@143.110.227.84 systemctl restart cone-server` | "Signal lost — re-establishing…", then the call returns within ~90 s, no fresh invites |
| 6 | One person force-quits the browser | Their tile disappears for everyone within ~1 min |
| 7 | That person re-opens the invite | They're back in the call |
| 8 | All four rejoin with `?forceTurn=1` inserted before the `#` in the invite | Call works relay-only; `chrome://webrtc-internals` active candidate pair reads relay/relay (flag is lost on refresh — re-add it) |

Also note (first real phone pass): landscape layout, tile labels after
someone leaves. Cosmetic findings go to the Phase 5/6 visual pass — record,
don't fix.
