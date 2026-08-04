# Show & Tell — run of show

~13 min. No slides. Tabs open before class: deployed app, `show-and-tell/compare.html`, screen-recording clip, `fallback.mp4` in Dock.

## Segments

1. **Live app + link** (1 min) — open the deployed app; post the URL in Slack.
2. **Solo walkthrough** (3 min) — lobby, equipment check (mention the OS-permission "Compromised" story), room UI.
3. **Two-person call clip** (2 min) — screen recording from the dress rehearsal; narrate: invite link, equipment check, join, podcast lock, tone marks, stop, transfer landing in the vault.
4. **Podcast mode + A/B** (4 min) — what the darkroom does (denoise, de-ess, compress, EQ, two-pass loudnorm, drift-corrected composite); then `compare.html`: play, flip mid-sentence (F key). Fallback: `fallback.mp4`.
5. **Reflections** (3 min) — see below.

## Reflections (pick and trim)

- **Hardest:** end-to-end encryption over WebRTC — insertable streams frame cipher, and debugging failures you can't see into. Runner-up: the zombie-websocket reconnect hunt.
- **Most interesting:** how much of "audio quality" is math — two-pass loudnorm, measured offsets, RNNoise; and NAT traversal (why TURN exists).
- **First times:** running my own TURN server on a droplet; OPFS + chunked file transfer with checksums; ffmpeg filter graphs; headless-Chrome rendering as a compositing engine; a multi-person live drill protocol.
- **Design decision worth naming:** the room grid is a deliberate no-scroll 2×2 — every face visible on a phone at once, tiles sized in dvh — chosen over a stacked scrolling mobile layout. Not a missing breakpoint; an intentional constraint the layout was built around.

## Rehearsal shot list (Tue 8/4)

Cmd-Shift-5, record the window. Capture in one pass, trim to ~90 s in QuickTime:
invite link → equipment check → join → podcast lock → tone marks → stop → transfer progress → take lands in vault.

## Pre-flight checklist

- [ ] Do NOT revoke professor/drill tokens until after Show & Tell; droplet redeploy before the rehearsal, never between rehearsal and class.
- [ ] Presenting machine: browser mic/camera allowed in System Settings → Privacy (the "Compromised"-card gotcha); iPhone Mirroring OFF if using Continuity Camera.
- [ ] `show-and-tell/` folder copied to a backup (USB or second machine) — GPU-flaky laptop insurance.
- [ ] Slack message drafted with the live URL.
- [ ] Classroom: volume check, display adapter, wifi fallback = phone hotspot.
