# 🕵️ Cone of Silence

An invite-only recording studio and call lobby, styled like a 1960s spy
dossier. Invited users get a zero-PII account, a WebRTC call room, and a
**Studio** that enhances podcast recordings with a real ffmpeg chain
(denoise → de-ess → compress → EQ → loudness) on a server I run.

**Live:** https://coneofsilence.app · **Stack:** Next.js + Tailwind (Vercel),
Express + WebSockets + ffmpeg (DigitalOcean), Supabase Postgres.

## Why this stack

- **Next.js + Tailwind, deployed on Vercel** — Tailwind v4's CSS-first tokens
  drive the whole dossier look (and both color schemes) from one file.
- **Express + WebSockets + ffmpeg on a DigitalOcean droplet** — call signaling
  needs a long-lived socket and audio enhancement needs real ffmpeg; neither
  fits serverless.
- **Supabase Postgres** — managed SQL with migrations, locked down so only the
  server's service-role key can read anything.

## Pages

| Route | Page |
| --- | --- |
| `/` | Lobby — invite-token check gates room creation |
| `/room` | WebRTC call (up to four) |
| `/account` | Invite-only register / login (codename + passphrase only) |
| `/studio` | Upload → watch it process → listen, download, or burn |
| `/admin` | Operator console: mint / relabel / revoke / purge invite tokens |
| `/brainstorm` | The original feature-plan dossier |

## Server API (`server/`)

| Endpoints | Purpose |
| --- | --- |
| `POST /tokens/verify` | Lobby token check |
| `POST /auth/signup·login·logout`, `GET /auth/me` | Accounts + bearer sessions |
| `POST·GET·DELETE /studio/recordings[/:id]` + artifact routes | Upload / list / fetch / burn recordings |
| `GET·POST·PATCH·DELETE /admin/tokens[/:id]` | Full token CRUD (operator secret) |
| `WS /ws` | Call signaling |

Everything is validated before touching the database and fails **closed**
(store down ⇒ 503, never a silent grant). Constant-time login, lockouts on
repeated failures, 1 GiB/file + 2 GiB/user upload caps, owner-scoped 404s.
130 vitest tests cover happy and sad paths.

## Schema

![Hand-drawn schema of the five tables](docs/sketches/schema.jpg)

`users 1—N sessions`, `users 1—N recordings`, `creation_tokens 1—N
token_events`. Migrations in `supabase/migrations/`; RLS on with zero
policies, so only the server's service-role key can read anything.

## Wireframes

![Account page wireframe](docs/sketches/wireframe-account.jpg)
![Studio page wireframe](docs/sketches/wireframe-studio.jpg)

## Privacy & limitations

- No PII: an account is a codename + bcrypt hash. Tokens stored as hashes.
- Uploads live on hardware I control; the raw file is deleted once the
  enhanced version exists; burning removes everything.
- Calls try a direct P2P path first and fall back to a TURN relay on
  hostile networks (e.g. cellular). Up to four participants.

## Design decisions

- **Zero PII.** An account is a codename and a passphrase hash; invites are
  stored as hashes. There is nothing worth stealing.
- **Fail closed.** Every endpoint validates before touching the database;
  store down means 503, never a silent grant.
- **Theme follows the OS.** One set of semantic CSS variables flips light and
  dark; no component ever branches on theme.
- **P2P first.** Calls try a direct path and fall back to a TURN relay only
  on hostile networks — cheapest path that still works on cellular.
- **Enhancement is server-side.** The ffmpeg chain runs on hardware I control
  so every listener gets the same result, regardless of their browser.

## Hardest parts

- **Four-way WebRTC.** Mesh negotiation, ICE restarts after network flips,
  and proving relay fallback on real cellular — debugged live on the droplet.
- **The synced podcast take.** Each browser records locally, then swaps
  tracks over the call's data channel into OPFS; making that survive a
  mid-take refresh took several drill-and-fix rounds.
- **Audio truth-finding.** Chasing an echo report through mute paths and
  transmit audits before it could be pinned as a playback loop, not a leak.

## Run locally

```bash
cd server && cp env.example .env && npm i && npm run dev   # API :8787
npm i && npm run dev                                       # frontend :3000
```

Studio processing needs `ffmpeg` (with `arnndn`) plus `RNNOISE_MODEL` and
`UPLOAD_DIR` in `server/.env`. Fresh database: `supabase db push`.

Darkroom (episode post): the podcast Mac needs node, ffmpeg with arnndn, and the rnnoise model at server/models/std.rnnn — `npm run darkroom -- --vault <Tape Vault>`.
