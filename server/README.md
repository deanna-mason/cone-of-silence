# Cone of Silence — server tier

One Node process serving both the trusted-tier HTTP API (Express: admin CRUD,
`POST /tokens/verify`, account auth, and the recording studio) and the
WebSocket signaling endpoint (`/ws`, protocol v1 — types in
`../lib/webrtc/protocol.ts`). Rooms live in memory only; the creation-token
store, accounts, and recordings are Supabase-backed persistence.

## API surface

| Route | Meaning |
| --- | --- |
| `POST /admin/tokens`, `GET /admin/tokens`, `PATCH /admin/tokens/:id`, `DELETE /admin/tokens/:id` | creation-token CRUD (bearer `ADMIN_SECRET`) |
| `POST /tokens/verify` | room-creation token check used by the frontend lobby |
| `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | account auth; signup burns a `kind:"signup"` token, login/me/logout use a bearer session token |
| `POST /studio/recordings`, `GET /studio/recordings`, `GET /studio/recordings/:id`, `GET /studio/recordings/:id/enhanced.m4a`, `GET /studio/recordings/:id/waveform.png`, `DELETE /studio/recordings/:id` | upload + manage recordings; requires a bearer session token; upload accepts mp3/m4a/wav/aac/flac/ogg/webm/mp4/mov/mkv up to 1 GiB and kicks the background job runner, which measures loudness, runs the `arnndn` noise-reduction pass, and renders a waveform PNG |

## Dev workflow (two terminals)

    # terminal 1 — frontend (repo root)
    npm run dev            # Next.js on http://localhost:3000

    # terminal 2 — this server
    cd server && npm run dev   # http + ws on :8787, reads .env

Room creation needs a creation token in the browser's localStorage — mint one
via the /admin page (or `POST /admin/tokens` with the bearer ADMIN_SECRET) and
open the lobby with `#create=<token>` once.

## Environment (`server/.env`, gitignored)

| Var | Meaning |
| --- | --- |
| `PORT` | default 8787 |
| `ADMIN_SECRET` | 16+ chars; bearer secret for `/admin/*` (required) |
| `ALLOWED_ORIGINS` | comma-separated; CORS + ws Origin allowlist (default `http://localhost:3000`) |
| `TOKEN_STORE` | `file` (default) or `supabase` — the creation-token store only |
| `TOKEN_FILE` | file-store path (default `data/tokens.json`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **always required** — accounts + studio (recordings) are Supabase-backed regardless of `TOKEN_STORE` |
| `UPLOAD_DIR` | where uploaded/processed recording files + waveforms live on disk (default `data/uploads`) |
| `RNNOISE_MODEL` | path to the RNNoise model consumed by ffmpeg's `arnndn` filter (default `models/std.rnnn`); the model binary is gitignored — copy it in locally, the box provisions it |

Frontend env (repo root): `NEXT_PUBLIC_API_URL` (default `http://localhost:8787`)
and `NEXT_PUBLIC_SIGNALING_URL` (default `ws://localhost:8787/ws`).

## Tests

    npm test           # vitest
    npm run typecheck
