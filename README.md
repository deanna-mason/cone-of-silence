# 🕵️ Cone of Silence

A two-page Next.js app styled like a 1960s spy title sequence. It previews my
final-project idea — a private, end-to-end encrypted video-calling app — through a
mock **Lobby** and a **Mission Dossier** that lays out the features I want to build.

**Live site:** https://cone-of-silence.vercel.app/
**Repository:** https://github.com/deanna-mason/cone-of-silence

Built for Assignment 1 to demonstrate components, props, state, list rendering,
conditional rendering, file-based routing, and deployment.

## Pages

- **`/` — Lobby:** a mock pre-call screen with a room-code field, a "Signal
  Scrambler" encryption toggle (show/hide explainer), and an "Initiate Contact"
  button that routes to the dossier.
- **`/brainstorm` — Mission Dossier:** the real feature plan as a redacted case
  file. Filter by All / Priority / Optional and tap any file to "declassify" its
  notes.

## Requirements demonstrated

| Requirement | Where |
| --- | --- |
| ≥ 3 components | `NavBar`, `RoomControls`, `EncryptionToggle`, `IdeaCard` |
| `useState` | Lobby (`roomCode`, `encryptionOn`), Dossier (`expandedId`, `filter`) |
| Passing props | every child component |
| Event-handler prop | `onToggle`, `onRoomCodeChange`, `onSelect` |
| List rendering with `.map()` + `key` | dossier ideas + filter tabs |
| Conditional rendering from state | encryption panel, declassified notes, filters |
| ≥ 2 pages via file-based routing | `/` and `/brainstorm` |
| `next/link` navigation | `NavBar` + "Initiate Contact" button |

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com)
- Fonts: Bebas Neue, Special Elite, Spectral (via `next/font`)
- Deployed on [Vercel](https://vercel.com) — every push to `main` auto-redeploys

## Run locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Project structure

```
app/
  layout.tsx          # shared shell + NavBar + fonts
  page.tsx            # "/"           Lobby
  brainstorm/page.tsx # "/brainstorm" Mission Dossier
  globals.css         # theme, film grain, stamps, animations
components/
  NavBar.tsx  RoomControls.tsx  EncryptionToggle.tsx  IdeaCard.tsx
lib/
  data.ts             # typed brainstorm data
```

## Project 1 — Multitier + Database

Midterm milestone: the lobby is now real. An operator mints reusable,
revocable invite tokens from an admin console; the lobby checks a token
with the server and gates the Create button client-side on the result.
Server-side enforcement of room creation itself arrives with Phase 2's
signaling gate. Two tiers (Next.js frontend, Express API) share a
Postgres database on Supabase.

### 1. Pages

- **`/` — Lobby:** reads an invite token from the URL fragment (or
  `localStorage`, so clearance survives a refresh), shows a clearance
  badge, and unlocks "Create room" once a token is on file — a stored
  token unlocks it optimistically even before/without live server
  confirmation, so the lobby re-verifies in the background and locks
  back down if the server reports it revoked.
- **`/room` — Call room:** the camera/mic green room from Phase 1. Room
  keys travel in the URL fragment and are stashed in `sessionStorage` on
  arrival, then the fragment is stripped from the address bar.
- **`/brainstorm` — Mission dossier:** the static feature-plan page from
  Assignment 1, unchanged.
- **`/admin` — Credential desk:** paste the admin secret to unlock a full
  CRUD console (mint / relabel / revoke / restore / purge tokens) that
  talks to the server tier over REST with a bearer token.

### 2. Server tier

The trusted tier lives in `server/` (Node/Express/TypeScript):

| Method | Path              | Auth   | Purpose |
| ------ | ----------------- | ------ | ------- |
| POST   | /tokens/verify    | none   | Lobby checks an invite token (body: `{token}`) |
| GET    | /admin/tokens     | Bearer | List grants |
| POST   | /admin/tokens     | Bearer | Mint (returns plaintext token ONCE) |
| PATCH  | /admin/tokens/:id | Bearer | `{label}` relabel, or `{revoked}` revoke/restore |
| DELETE | /admin/tokens/:id | Bearer | Purge a grant and its audit events |

Bearer auth is the `ADMIN_SECRET` value; 5 bad attempts trigger a 60s
lockout. Every request is validated before it touches the store, and the
store fails **closed**: if the database is unreachable, verification and
admin calls return a 503 rather than silently granting access. All of this
is covered by the vitest suite in `server/test` (34 passing tests, plus a
shared store-contract suite run against both the file-backed and
Supabase-backed `TokenStore` — the Supabase half skips automatically
without live credentials).

### 3. Schema

```
┌──────────────────────────┐        ┌─────────────────────────────┐
│ creation_tokens          │        │ token_events                │
├──────────────────────────┤        ├─────────────────────────────┤
│ id  uuid PK              │◄───────│ token_id  uuid FK (cascade) │
│ label  text 1..64        │  1:N   │ id  bigint PK               │
│ token_hash  text UNIQUE  │        │ event  minted|relabeled|    │
│ created_at  timestamptz  │        │        revoked|restored     │
│ last_used_at timestamptz?│        │ occurred_at  timestamptz    │
│ revoked_at  timestamptz? │        │ detail  jsonb?              │
└──────────────────────────┘        └─────────────────────────────┘
   RLS enabled, zero policies — server-only via service-role key.
   Stores operator config (labels the operator typed + hashes).
   No user data: no names, no emails, no call records.
```

### 4. Privacy note

Tokens are stored as SHA-256 hashes, never in plaintext — sound here
because each token is 128 random bits, so no bcrypt-style key-stretching
is needed. Token use is deliberately **not** event-logged: a successful
verify only overwrites `last_used_at` in place, so there's no per-call
audit trail to leak. There are no accounts, names, or emails anywhere in
the schema — the database stores operator configuration (who is allowed
to create a room), not user data.

### 5. Run locally

Two terminals, one for each tier:

```bash
# terminal 1 — server
cd server
cp env.example .env    # fill in ADMIN_SECRET (and SUPABASE_* for TOKEN_STORE=supabase)
npm install
npm run dev             # http://localhost:8787

# terminal 2 — frontend (repo root)
npm install
npm run dev              # http://localhost:3000
```

Against a fresh Supabase project, push the schema before starting the
server with `TOKEN_STORE=supabase`:

```bash
supabase db push
```

### 6. Wireframes

No screenshots yet — the four pages, described above, stand in for now:
the **Lobby** (clearance badge + gated create button), the **Call room**
(camera/mic green room), the **Mission dossier** (static feature plan),
and the **Credential desk** (paste-to-unlock admin CRUD table). Screenshots
can be dropped into `docs/` and linked here later.
