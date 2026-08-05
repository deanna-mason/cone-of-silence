# Podcast dress rehearsal — 2026-08-04

Full-length two-host episode take (Deanna + Lily), run as the Show & Tell
rehearsal. The take completed, exchanged, and developed; findings below.

## F1 — echo on the rehearsal tape (root cause: acoustic bleed)

Diagnosed 8/5: Lily's side ran on **open speakers**. Deanna's voice played
out of Lily's speakers, re-entered Lily's mic, and was **baked into her raw
tape** at ~465 ms delay. Not a transmit leak, not a mute-path bug — the
echo is in the source recording, so no downstream fix can remove it.

- A headphones toggle/check did not exist at rehearsal time. The per-take
  headphones declaration (Roll Tape gated on the answer, partner
  visibility) shipped 8/5.
- **An "echo-guard" capture mode shipped alongside it and was withdrawn the
  same day.** It asked the recording capture for `echoCancellation: true`
  when a host declared open speakers. Measured on real hardware (all four
  inputs on Deanna's Mac): that request returns `EC=true` standalone but
  **silently returns `EC=false` whenever the call already holds the mic** —
  which is always, in production. Chrome will not give a second concurrent
  capture of a device its own echo canceller. The mode's fail-closed assert
  fired correctly during a live attempt ("ECHO-GUARD FAILED") and blocked
  the take; the protection it guarded could never have existed. The
  declaration now warns and stamps provenance (`phones` in the audio
  sidecar) instead. Fake-device e2e could not have caught this — fake
  devices honor any constraint asked of them.
- **Headphones are the only remedy.** A speakers host records bleed, full
  stop. Re-take done on headphones 8/5.

## F2 — three mic silences, self-recovered without user action

Lily ~2:00 · Parfait ~7:20 · Deanna ~16:38 (mm:ss into the call). Each
went silent for a stretch and came back on its own; no fault card, no
Signal Lost badge.

Code-path investigation (8/5, read-only): **no designed self-heal
mechanism explains these.** Every designed recovery — ICE restart
(`lib/webrtc/mesh.ts` failed/3 s-grace branches), full link rebuild,
zombie-websocket reconnect (`lib/webrtc/signaling.ts`) — kills audio AND
video together and necessarily paints the Signal Lost badge or empties the
tile, none of which happened. There is no track-restart-on-ended, no
devicechange listener, and nothing at all monitors the call's local audio
track. Leading explanations, in order:

1. **E2EE fail-closed frame drops** (`lib/crypto/frameCipher.ts`): a
   corrupted frame fails its AES-GCM tag and is silently discarded — under
   E2EE, loss that Opus concealment would normally paper over becomes hard
   silence, healing the instant frames decrypt again. Zero logging today.
2. **Plain network loss / jitter-buffer dropout** with no client mechanism
   involved at all — equally invisible: the app never calls `getStats()`.
3. Mic contention from the record graph's second `getUserMedia` on the
   same device at roll/stop boundaries (worth checking the timestamps
   against take events).

**To confirm on a future drill:** log connection-state transitions +
restart/rebuild events in `mesh.ts`, count E2EE decrypt drops per pipe in
`e2ee.worker.ts`, and add a 1 Hz `getStats()` sampler — the discriminator
is `concealedSamples` rising while `packetsLost` stays flat (received but
thrown away by decrypt = E2EE drop; both rising = network loss). Also: the
podcast watchdog watches the record graph's mic, not the call mic — a call
mic can die mid-take without a card.

## F3 — video freeze, fast heal, no fault card

Lily's video froze briefly and recovered with no card. **Working as
designed:** the Signal Lost badge deliberately waits 3 s
(`hooks/useSignalLostBadge.ts` anti-flash rule), and the ICE-restart grace
is the same 3 s — any stall that heals inside that window shows nothing,
on purpose. No badge means the connection never left `connected` for 3 s;
the freeze healed inside the browser (or was frame drops as in F2). The
podcast fault card only watches the LOCAL camera track, so a remote freeze
can never raise it.

## Feedback-driven changes (shipped 8/5)

- **Speaking glow reworked:** gold dot removed, the slim brass outline
  (old self-view variant) now marks every tile, and it latches on the most
  recent speaker until a different person speaks — no more per-word
  flashing (`hooks/useSpeakerLatch.ts`).
- **Pre-roll send affordance fixed:** before any reel rolls in a session,
  the armed card's send button re-offers the take restored from a previous
  session (reload recovery) — it now says **Send Last Take** instead of
  implying a fresh episode exists.

## In-class four-person test — Mon 2026-08-03 (recorded here 8/5)

Run by Deanna in class; closes the gaps the 8/3 evening drill left
unrecorded:

| Check | Result |
|-------|--------|
| Participant drops wifi, rejoins | **PASS** |
| Participant force-quits browser, rejoins | **PASS** |
| Podcast mode: self mic-cut → no mic bleed | **PASS** |
| Podcast mode: both participants muted → no mic bleed | **PASS** |

This closes the 8/3 report's unrecorded step-4 wifi-blip check and
satisfies four-person-drill.md's "re-run before the final demo"
instruction. Both files are annotated.

## Repo-history check (2026-08-05)

`git log --all --name-only` against origin: **no `*.tsbuildinfo` anywhere
in history.** One transcript file
(`2026-07-03-211634-local-command-caveatcaveat-the-messages-below.txt`)
was committed in `bae9537` and removed in `e80acf4` — it is out of both
branch tips and gitignored, but its content remains reachable in remote
history. Purging it requires a history rewrite + force push; deliberately
not done without sign-off. It is a session transcript, not a secret.
