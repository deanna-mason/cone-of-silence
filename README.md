# 🕵️ Cone of Silence

A private, invite-only recording studio and call lobby, styled like a 1960s spy
dossier. Operators mint invite tokens; invited users get a zero-PII account, a
WebRTC call room, and a **Studio** that enhances their podcast recordings with
a real ffmpeg processing chain on hardware I control.

**Live site:** https://coneofsilence.app
(also at https://cone-of-silence.vercel.app)
**Repository:** https://github.com/deanna-mason/cone-of-silence

Started as Assignment 1 (a two-page mock), now a working multitier app for
Project 1, and the foundation for my final project: an end-to-end encrypted
video-calling app that can record and process podcast episodes.

## Pages

- **`/` — Lobby:** reads an invite token from the URL fragment (or
  `localStorage`), verifies it with the server, and gates "Create room" on the
  result. Joining a call is never gated.
- **`/room` — Call room:** a real two-person WebRTC call (camera/mic pickers,
  perfect negotiation, automatic rejoin after a dropped connection). Room keys
  travel in the URL fragment — they are never sent to the server.
- **`/account` — Identity Desk:** invite-only registration (single-use signup
  token) and login. Accounts are a codename + passphrase, nothing else.
- **`/studio` — Development Desk:** upload a recording, watch it move through
  the enhancement queue, then listen, download, or burn the result.
- **`/admin` — Credential Desk:** paste the operator secret to mint, relabel,
  revoke/restore, and purge invite tokens of both kinds.
- **`/brainstorm` — Mission Dossier:** the original feature-plan page from
  Assignment 1.

## Project 1 — Multitier + Database

Two tiers share a Postgres database on Supabase: this Next.js frontend
(Vercel) and a Node/Express + WebSocket server (`server/`) on a DigitalOcean
droplet behind Caddy TLS at `api.coneofsilence.app`, where ffmpeg runs.

### Server tier

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | /tokens/verify | none | Lobby checks an invite token |
| POST | /auth/signup | signup token | Register (burns the single-use token) |
| POST | /auth/login | none | Log in → bearer session token |
| POST | /auth/logout | session | End the session |
| GET | /auth/me | session | Who am I / is my session live |
| POST | /studio/recordings | session | Upload a recording (≤ 1 GiB) |
| GET | /studio/recordings | session | List my recordings |
| GET | /studio/recordings/:id | session | One recording + status |
| GET | /studio/recordings/:id/enhanced.m4a | session | The processed audio |
| GET | /studio/recordings/:id/waveform.png | session | Waveform image |
| DELETE | /studio/recordings/:id | session | Burn a recording + its files |
| GET/POST | /admin/tokens | operator | List / mint invite tokens |
| PATCH/DELETE | /admin/tokens/:id | operator | Relabel, revoke/restore / purge |

Everything is validated before it touches the database, and every store
failure **fails closed** (503, never a silent grant). Wrong passwords and
unknown usernames are indistinguishable (constant-time compares); repeated
bad logins, signups, and admin attempts hit a lockout. Uploads are capped at
1 GiB per file and 2 GiB per user, recordings are scoped to their owner
(anyone else gets a plain 404), and the whole surface is covered by the
vitest suite in `server/test`.

The enhancement pipeline is my own podcast chain, run verbatim by the server
job runner: highpass → RNNoise denoise → de-esser → compressor → EQ →
two-pass loudness normalization → AAC, plus a rendered waveform.

### Schema — five tables

![Hand-drawn schema diagram of the five tables](docs/sketches/schema.jpg)

Two worlds that deliberately never reference each other: **invite tokens**
(`creation_tokens` 1—N `token_events`, an audit log) and **accounts**
(`users` 1—N `sessions`, `users` 1—N `recordings`, both cascading on user
deletion). Migrations are committed in `supabase/migrations/`. Every table
has row-level security enabled with **zero policies** — nothing is readable
except through the server's service-role key.

### Wireframes

![Hand-drawn wireframe of the account page](docs/sketches/wireframe-account.jpg)
![Hand-drawn wireframe of the studio page](docs/sketches/wireframe-studio.jpg)

### Privacy, honestly

- **Zero PII.** An account is a codename and a bcrypt passphrase hash. No
  email, no recovery flow (the operator resets you), no names.
- **Tokens are stored as hashes** (SHA-256 of 128 random bits), shown in
  plaintext exactly once at mint time.
- **Your uploads land on hardware I control** — a $6 DigitalOcean droplet I
  administer — not a third-party media service. The raw upload is deleted
  automatically the moment the enhanced version exists; burning a recording
  removes the database row and every file.
- **Call room keys never reach the server.** They live in the URL fragment,
  which browsers do not transmit.

### Known limitations (also honest)

- **Calls are STUN-only for now.** Two devices on the same network (or most
  home networks) connect fine; a phone on cellular data or other
  strict/symmetric NAT setups will fail to get media through. I confirmed
  this during acceptance testing with `chrome://webrtc-internals`: candidates
  are exchanged and pairs form, but ICE fails — the fix is a TURN relay
  (coturn) on the droplet, which is planned for the final project.
- If both sides drop while a room is empty for ~30 s, the invite link dies
  and the creator has to mint a fresh room.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript, Tailwind CSS —
  deployed on Vercel; every push to `main` auto-redeploys
- Node 22 + Express 5 + `ws`, vitest — DigitalOcean droplet, Caddy TLS,
  systemd (deploy scripts + runbook in `deploy/`)
- Supabase Postgres (row-level security on, service-role only)
- ffmpeg + RNNoise for the enhancement chain

## Run locally

Two terminals, one per tier:

```bash
# terminal 1 — server
cd server
cp env.example .env    # ADMIN_SECRET + SUPABASE_* (and TOKEN_STORE=supabase)
npm install
npm run dev            # http://localhost:8787

# terminal 2 — frontend (repo root)
npm install
npm run dev            # http://localhost:3000
```

The Studio pipeline additionally needs `ffmpeg` (built with the `arnndn`
filter) on your PATH and an RNNoise model file — set `RNNOISE_MODEL` and
`UPLOAD_DIR` in `server/.env`. Against a fresh Supabase project, push the
schema first with `supabase db push`.

## Project structure

```
app/                    pages: lobby, room, account, studio, admin, brainstorm
components/             UI components (dossier theme)
hooks/ lib/             WebRTC session, media, API clients
server/src/             Express + ws signaling + studio job runner
server/test/            vitest suite
supabase/migrations/    committed schema
deploy/                 provision.sh, deploy.sh, Caddyfile, RUNBOOK.md
docs/sketches/          hand-drawn schema + wireframes (embedded above)
```

## Assignment 1 heritage

The original two-page version demonstrated components, props, `useState`,
event-handler props, list rendering with keys, conditional rendering,
file-based routing, and `next/link` — the Lobby and Mission Dossier pages
still carry that work (see the git history for the write-up).
