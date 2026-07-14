# Cone of Silence — server tier

One Node process serving both the trusted-tier HTTP API (Express: admin CRUD +
`POST /tokens/verify`) and the WebSocket signaling endpoint (`/ws`, protocol
v1 — types in `../lib/webrtc/protocol.ts`). Rooms live in memory only; the
creation-token store is the sole persistence (operator config, no user data).

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
| `TOKEN_STORE` | `file` (default) or `supabase` |
| `TOKEN_FILE` | file-store path (default `data/tokens.json`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | required when `TOKEN_STORE=supabase` |

Frontend env (repo root): `NEXT_PUBLIC_API_URL` (default `http://localhost:8787`)
and `NEXT_PUBLIC_SIGNALING_URL` (default `ws://localhost:8787/ws`).

## Tests

    npm test           # vitest
    npm run typecheck
