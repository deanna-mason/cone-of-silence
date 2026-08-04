# Security Model — Cone of Silence

This is an honest threat model. It separates three things and never blurs them:

- **Guarantees** — properties the design actually enforces in code.
- **Defense-in-depth** — layers that reduce blast radius but are not the primary
  control.
- **Accepted risks** — known limits we understand, have weighed, and chose to
  ship.

Every claim is grounded in the code paths named alongside it.

---

## 1. Architecture and trust model

Cone of Silence is a small-group (up to 4 seats) encrypted video app with a
podcast recording mode. Three parties hold infrastructure:

- **Vercel** serves the static frontend (Next.js).
- **A DigitalOcean droplet** runs the signaling WebSocket server and a coturn
  TURN relay (behind a TLS-terminating reverse proxy).
- **Supabase** stores accounts, sessions, and single-use tokens.

The server is a **trusted postman**. It relays signaling messages and issues
TURN credentials, but it **never sees plaintext media, the room secret, or any
key derived from it**. That is the load-bearing property this whole document
defends. The server *can* see metadata (§3) — the honesty of the model is in
naming exactly what "trusted postman" does and does not cover.

Media is peer-to-peer WebRTC in a full mesh; the TURN relay carries only
already-E2EE-encrypted frames when a direct path is unavailable, so a relayed
call is no more exposed to the server than a direct one.

---

## 2. The E2EE story

**Everything keys off one secret that the server never receives.**

### The room secret and its transport

A room is identified by two independent 128-bit random tokens minted
client-side (`lib/roomLink.ts`): a `roomId` and a `secret`, each 16 bytes
encoded as 22-char base64url. Both ride in the **URL fragment**
(`#r=<roomId>&s=<secret>`, `buildRoomHash`). The fragment is never sent in an
HTTP request and never appears in a WebSocket frame — the client stashes the
keys per-tab and sends only the `roomId` to the signaling server. The `secret`
is the E2EE root and the server has no path to it.

The capability URL *is* the access grant: whoever holds the full link
(`roomId` + `secret`) can derive the room's keys. This is a deliberate
capability-URL design (see §5 and §7).

### Key derivation (`lib/crypto/derive.ts`)

`decodeSecret` validates the secret against the exact 22-char base64url wire
format and rejects non-canonical encodings (the trailing 4 bits must be zero,
enforced by re-encode-and-compare) so the secret↔bytes mapping is a bijection.
The 16 bytes are imported as HKDF-SHA-256 input keying material, then
`deriveKey` produces **three independent, purpose-bound, non-extractable
WebCrypto keys** in one pass, using a fixed salt and distinct `info` labels:

- `mediaKey` — AES-GCM-256, for real-time media frames.
- `xferKey` — AES-GCM-256, for podcast episode transfer chunks.
- `proofKey` — HMAC-SHA-256, for the mutual join-proof.

All three are `extractable: false`; the raw keying material never leaves the
derivation function's stack. A leak of one derived key cannot be turned into the
others, and none can be exported back out through the WebCrypto API.

### Frame encryption (`lib/crypto/frameCipher.ts`, `lib/webrtc/e2ee.worker.ts`)

Each PeerLink runs its own Web Worker that transforms every encoded media frame
off the main thread. The AES-GCM nonce is a **96-bit IV = 32-bit random prefix +
64-bit big-endian counter** (`IvState`). The prefix is drawn fresh at every
`IvState` construction; the counter starts at 0, increments per frame, and
`next()` **throws rather than wrap** past 2^64-1 — nonce reuse under a fixed
prefix is a catastrophic GCM break, so the code refuses it structurally. Exactly
one `IvState` is constructed per encrypt pipe, at pipe attach time, and is never
shared or rebuilt with a stashed counter.

Encrypt and decrypt are **fail-closed in the right directions**: `encryptFrame`
throws loudly on bad input (a caller bug must never silently emit a
zero-plaintext frame), while `decryptFrame` returns `null` on *any* problem —
short input, bad/tampered tag, wrong key — and the worker transform **drops the
frame** (black tile) rather than throwing or ever forwarding plaintext. There is
no plaintext-fallback path in production.

### Mutual join-proof gates all trust (`lib/webrtc/joinProof.ts`)

Before either side trusts a peer, **both** challenge each other with a random
16-byte nonce and must answer with `HMAC(proofKey, len(nonce) ‖ nonce ‖
len(responderPeerId) ‖ responderPeerId ‖ "resp")`. Two design details are the
actual defenses:

- **Responder-id binding** defeats reflection/replay: a bounced-back or replayed
  MAC was signed under the wrong identity and fails verification even though it
  is a genuine HMAC.
- **Length-prefixed MAC input** removes the concatenation ambiguity that would
  otherwise let an attacker who controls both its own peerId and the nonce
  choose a split point that reads back as a different, victim-accepted pair.

A peer proves nothing until it answers *our* outstanding challenge correctly.
The outstanding nonce is consumed on use (no replay), self-challenge is refused
in the constructor, and `proven`/`failed` are terminal. A **timeout is treated
as jank, not evidence** — the first expiry re-arms once with a fresh nonce while
the phase stays `pending` (all trust gates shut); only the second expiry fails.
Bad-MAC is immediately terminal at any point.

**Consequence — wrong-secret joiners are carded, honest incumbents are never
interrupted.** A joiner with the wrong secret derives the wrong `proofKey`,
never produces a valid MAC, and so is never proven by anyone — their media,
data, and roster presence stay gated (invisible/silent). The refusal card is
shown *only* to the wrong-secret joiner via a double-latch (`session.ts`), which
correctly withholds the card from an innocent incumbent across reconnect and
peer churn.

### E2EE guarantees vs. limits

- **Guarantee:** the server (and anyone who lacks the fragment secret) cannot
  read or forge media or episode content. Confidentiality and integrity of
  content hold against a server-MITM.
- **Guarantee:** a wrong-secret party cannot join the trusted set, be seen, or
  be heard.
- **Limit:** the secret is a *bearer capability*. Anyone who obtains the full
  URL is inside. See §3, §4, §5.

---

## 3. What the server CAN see (honest metadata list)

"Trusted postman" is confidentiality of *content*, not of *metadata*. The
signaling server and droplet operator can observe:

- **Room occupancy and membership churn** — which `roomId`s exist, how many
  seats are filled, and joins/leaves over time (the server routes signaling by
  `roomId`).
- **Connection timing** — when a room is created, when each participant joins
  and drops, call duration.
- **IP addresses** of every participant (signaling connection, and TURN-relayed
  traffic when TURN is used). Rate-limiting/lockout is IP-keyed.
- **Coarse traffic volume** for relayed streams passing through coturn.
- **Account metadata** in Supabase — usernames (codenames, zero-PII by design),
  session and token records.

The server does **not** see: the room `secret`, any derived key, media frames,
episode bytes, or the content of the encrypted data channel. A server-MITM is
the exact adversary the E2EE exists to neutralize for *content*; it retains the
metadata above.

---

## 4. Client-persistent storage caveats (deliberate, documented)

Three items live in `localStorage`, which is **device-persistent and readable by
any script running on the origin** (i.e. XSS-readable). This is a deliberate
architectural choice tied to the bearer model and a cross-origin API on the
droplet, not an oversight:

- **Bearer session token** (`cos-session`, `lib/authApi.ts`) — stored in
  `localStorage`, never in a cookie.
- **Durable room-creation token** (`cos-create-token`, `lib/createToken.ts`) —
  deliberately durable so clearance outlives a single call; ended only by
  revocation or burn.
- **Pinned Studio room** (`cos-studio-room`, `lib/studioRoom.ts`) — the standing
  podcast room a logged-in host returns to. It stores a full `RoomKeys`,
  **including the room `secret`**, so a room secret is device-persistent and
  XSS-exfiltratable here. This is a conscious tradeoff: convenience, never
  authority — the server still gates room creation, and the secret still never
  reaches any server. It is the one place a room secret lives in the durable
  storage tier.

**The *live* per-call room secret is not in this tier.** During a call the room
keys are held in **`sessionStorage`** (`cos-room`, `lib/roomLink.ts`), which is
tab-scoped and cleared when the tab closes — a shorter-lived exposure than
`localStorage`. Only the deliberately pinned Studio room persists a secret past
the tab's life.

**Why this is acceptable, and the defense-in-depth that backs it.** There is
**no script-injection sink in the app**: a repo-wide search finds no
`dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` in `app/`,
`components/`, `lib/`, or `hooks/`; React's default output escaping is the
standing control and there is no known XSS. The exposure is therefore "if an XSS
ever appears (a dependency, a future feature), the blast radius from
`localStorage` is total" — not "there is an XSS."

The defense-in-depth layer is a **live Content-Security-Policy**, set in
`next.config.ts` on every response, that contains an injected script's reach:

- `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `form-action 'self'`, `upgrade-insecure-requests`.
- `connect-src 'self'` plus only the app's own API (`https`) and signaling
  (`wss`) origins — this is the exfiltration constraint: an injected script has
  nowhere off-origin to POST a stolen secret.
- `worker-src 'self' blob:` for the E2EE worker; `media-src 'self' blob:` for
  recorded-audio playback; `img-src 'self' data: blob:`; `font-src 'self'`.
- `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'`.
  `'unsafe-inline'` is required and honestly disclosed: the App Router streams
  its payload via inline `<script>` tags and `next/font` injects inline
  `@font-face` styles. It is set statically in `next.config.ts` rather than via a
  per-request nonce, which would force every page to dynamic rendering.
  **There is no `'unsafe-eval'` in production** — no client WebAssembly, no
  `eval`, and the E2EE worker is a bundled ES module.

The response also carries HSTS (preload), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and
a `Permissions-Policy` that grants only `camera`/`microphone`/`autoplay`/
`fullscreen` to self and denies everything else.

The `localStorage`-vs-httpOnly-cookie tradeoff is defensible **precisely because
it is paired with this CSP**: `'unsafe-inline'` leaves script injection
conceivable, but `connect-src 'self'`-plus-own-API removes the injected script's
exfiltration path, turning a hypothetical XSS from clean takeover into a
contained event.

---

## 5. Known limits and accepted risks

Each item was verified against code during adversarial review.

### 5.1 — IV prefix as sole cross-pipe separation under a non-rotating key (accepted)

The GCM nonce's only cross-pipe separation is its **32-bit random prefix**, and
`mediaKey`/`xferKey` are HKDF'd with a *fixed* salt/info, so they are
**constant for the entire life of an invite link**, across every call and
participant — the key never rotates. Within a pipe there is no reuse (monotonic
counter, refuses to wrap). Across pipes, two sharing a prefix would collide from
counter 0 (two-time-pad + forgery on overlapping frames); the birthday bound is
≈50% at ~2^16 pipes.

- **No IV reuse across rebuilds** — a specifically checked worry, found
  **clean**: a fresh prefix is drawn per worker encrypt pipe, per
  `EpisodeSender.start()`, and every mesh rebuild constructs a fresh PeerLink →
  fresh worker → fresh `IvState`.
- **Negligible at project scale:** a podcast recorded a handful of times
  accumulates at most hundreds of pipes; collision probability ≈ (few hundred)²
  / 2^33 ≈ 10⁻⁵, and it is not exploitable by anyone who does not already hold
  the secret.
- **Future hardening:** widen the random IV portion, or fold a per-pipe random
  salt into the HKDF so each pipe gets an independent subkey (removes the
  shared-key birthday bound entirely). Not needed for this timeline.

### 5.2 — TURN credentials: 12h TTL, shared, handed to any joiner (accepted)

TURN creds use the standard coturn `use-auth-secret` REST model: `username =
floor(now/s) + ttl` (default 43200s = **12h**), `credential = HMAC-SHA1(secret,
username)`. Creds are **not per-user** — everyone joining in the same second gets
the same reusable credential, minted into every `created`/`joined` reply. Anyone
who can seat themselves in a room can harvest a credential and relay arbitrary
traffic through coturn for up to 12h.

- **Impact: bandwidth abuse only**, by a party already authorized into a room.
  Creds are never on an open endpoint.
- **Optional mitigation (config-only, no code change):** shorten the TURN TTL
  (1–2h still outlives any sane call while shrinking the reuse window).

### 5.3 — Unauthenticated join = seat-occupation DoS (accepted, inherent)

Only room *creation* is token-gated; *joining* requires only a `roomId`. Anyone
holding a `roomId` can occupy one of the 4 seats, so 4 squatters can make the
room appear full to a legitimate fifth participant. E2EE keeps a wrong-secret
squatter invisible and silent (§2), but they still consume a seat.

- This is **inherent to the capability-URL model**: the secret protects
  *confidentiality*, not seat *availability*, and reaching a room at all
  requires the unguessable 128-bit `roomId`. It reduces to "a party you already
  invited can grief." No fix; named as an accepted property.

### 5.4 — Signup username-enumeration oracle (accepted, mitigated)

With a *valid* signup token, `POST /auth/signup` returns 409 "codename taken"
before burning the token — a username-existence oracle. It is mitigated: it
requires a valid signup token, every 409 records an IP failure, and the IP is
locked out after 5 probes for 60s. Login is **not** an oracle (generic `denied`
for both unknown-user and wrong-password, with an equalizing bcrypt compare
against a dummy hash). Documented as a known, rate-limited, token-gated oracle.

### 5.5 — xfer envelope header AAD gap (accepted — confirmed safe to defer)

The episode-transfer chunk envelope carries `version ‖ enc ‖ reserved ‖ seq ‖
IV` in the clear; AES-GCM authenticates only the payload+tag, not these header
fields. Review traced every tamperable field and each collapses to a clean
fault:

- **IV** → any change fails the GCM tag → `decryptFrame` null → decrypt-failed
  fault. Not forgeable.
- **enc** → must be 1; `enc=0` is an unconditional plaintext-downgrade fault,
  checked before seq/count. No downgrade.
- **seq** → strictly `=== nextSeq`, bounded by announced count; reorder/replay
  faults.
- **version/length** → malformed-chunk fault.
- **JSON control frames** (name/size/sha256/codename) are cleartext, but chunk
  *content* is GCM-encrypted under `xferKey` (which a MITM lacks) and the final
  bytes are re-verified against the sidecar `sha256` at commit.

**Verdict:** a MITM gets **DoS + metadata visibility**, but **cannot forge or
silently corrupt episode content**. Both residuals a MITM already has by other
means (dropping the connection; the metadata the model already concedes).
Deferral is confirmed correct.

### 5.6 — Chrome-only podcast mode (accepted)

The E2EE worker relies on Chrome encoded-transform APIs (Insertable Streams /
RTCRtpScriptTransform). Podcast recording mode is supported on Chrome only; this
is a stated compatibility limit, not a security weakness.

---

## 6. Found and fixed: ffmpeg untrusted-input protocol whitelist

The one High from adversarial review: `ffmpeg` demuxes untrusted uploads and
auto-detects format from *content*, so a crafted container (concat/hls/subfile/
image2, etc.) could open `file://`/`http://` resources during processing — a read
primitive against droplet environment secrets muxed into the served output, or
SSRF.

**Status: FIXED and deployed.** `-protocol_whitelist file,pipe` is prepended to
the input on **all** untrusted-input passes — `measureArgs`, `applyArgs`, and
`waveformArgs` (`server/src/studio/ffmpegArgs.ts`) — pinning ffmpeg to the local
file plus pipe only, covered by `server/test/ffmpegArgs.test.ts`. The fix is
live on the processing host. Recorded here as found-and-fixed, not open.

---

## 7. Account-tied rooms: considered and rejected

A natural feature request is "let my account remember my room so a new device
just logs in and enters." We considered three ways to have the server help, and
rejected all three, because each weakens the trust root that §1–§2 depend on.
The refusal is deliberate and is the point of this section.

- **(A1) Server stores the room secret.** This is **key escrow**. It breaks the
  "server never sees the secret" guarantee outright — the server could derive
  every room key and read all content. Rejected on principle.

- **(A3) Server stores only the `roomId`.** This adds a **new user↔room metadata
  association the server never held before**, bought for **zero UX gain**: a
  `roomId` without the `secret` cannot derive any key, so a new device *still*
  needs an out-of-band secret handoff — identical to the client-only approach,
  but now with extra server-side linkage to leak. Rejected as
  metadata-for-nothing.

- **(A2) Server stores a client-side-wrapped secret** under a password-derived
  wrap key. This is the **only principled server option** — the server holds
  ciphertext it cannot open. But doing it correctly requires adopting a **PAKE
  (e.g. OPAQUE)** so the password stops being sent to the server for bcrypt
  (otherwise the server sees the password and can derive the wrap key, collapsing
  back to A1), **plus** re-wrap-on-password-change and the property that
  "password reset destroys the wrapped secret." That is real, correct design —
  and **too large for this timeline**. Named as the **future path**, not adopted.

**Chosen approach: client-only "Studio Home."** The **capability URL itself is
the device-handoff mechanism**; nothing about a room is stored server-side beyond
what §3 already lists. The pinned Studio room (§4) keeps its convenience state
**client-side only** — the room secret never reaches a server. **The threat model
in §1–§2 is unchanged.** The cost is that a new device needs the invite link
out-of-band, which is exactly the property a capability-URL system is supposed to
have.

---

## 8. Areas attacked and found sound

Reported because "nothing exploitable here" is a result: join-proof
reflection/replay, `encryptFrame` fail-open (none — fail-closed both
directions), wrong-secret refusal-card logic, cross-user Studio recording access
(owner-scoping + 404-on-mismatch), admin auth/lockout (constant-time compare,
per-IP lockout, operator secret required to be ≥16 chars at startup), session
handling (bearer hashed before lookup, server-side expiry, fail-closed on store
error), WebSocket Origin/upgrade (allowlisted Origin, 403 on foreign/missing,
128 KiB max payload), and room-create gating (token-required, fail-closed). No
bypass found in the E2EE core.
