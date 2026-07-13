# Cone of Silence — server

The trusted tier: creation-token allowlist + admin CRUD API (this phase);
WebSocket signaling joins it in Phase 2.

## Run locally

    cp env.example .env    # then fill in ADMIN_SECRET
    npm install
    npm run dev            # http://localhost:8787

Two-terminal dev workflow: `npm run dev` here, `npm run dev` at the repo root
(Next.js on :3000). The frontend reads NEXT_PUBLIC_API_URL (defaults to
http://localhost:8787).

## Endpoints

| Method | Path              | Auth   | Purpose |
| ------ | ----------------- | ------ | ------- |
| POST   | /tokens/verify    | none   | Lobby checks an invite token (body: `{token}`) |
| GET    | /admin/tokens     | Bearer | List grants |
| POST   | /admin/tokens     | Bearer | Mint (returns plaintext token ONCE) |
| PATCH  | /admin/tokens/:id | Bearer | `{label}` relabel, or `{revoked}` revoke/restore |
| DELETE | /admin/tokens/:id | Bearer | Purge a grant and its audit events |

Bearer = the ADMIN_SECRET value. 5 bad attempts → 60s lockout.
Store outages fail CLOSED (503) — an outage never grants access.

## Tests

    npm test               # vitest; networkless (file store)
