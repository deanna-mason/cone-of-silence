-- Invite-token allowlist: operator config, NOT user data.
-- Labels are operator-typed nicknames; tokens are stored as SHA-256 hashes only.

create table creation_tokens (
  id           uuid primary key default gen_random_uuid(),
  label        text not null check (char_length(label) between 1 and 64),
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,          -- overwritten in place; deliberately NOT an event log
  revoked_at   timestamptz           -- null = active
);

create table token_events (
  id          bigint generated always as identity primary key,
  token_id    uuid not null references creation_tokens(id) on delete cascade,
  event       text not null check (event in ('minted','relabeled','revoked','restored')),
  occurred_at timestamptz not null default now(),
  detail      jsonb
);

create index token_events_token_id_idx on token_events (token_id);

-- RLS on, ZERO policies: the anon key can touch nothing.
-- Only the server's service-role key (which bypasses RLS) may read/write.
alter table creation_tokens enable row level security;
alter table token_events enable row level security;
