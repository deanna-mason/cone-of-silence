-- Accounts (zero PII: username + hash only) + Studio recordings metadata.
-- Same posture as invite tokens: RLS on, ZERO policies — service-role key only.

alter table creation_tokens
  add column kind text not null default 'room-creation'
  check (kind in ('room-creation','signup'));

alter table token_events drop constraint token_events_event_check;
alter table token_events add constraint token_events_event_check
  check (event in ('minted','relabeled','revoked','restored','redeemed'));

create table users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);

create table recordings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  original_name text not null check (char_length(original_name) between 1 and 200),
  source_ext    text not null check (source_ext ~ '^\.[a-z0-9]{2,5}$'),
  status        text not null default 'queued'
                check (status in ('queued','processing','done','error')),
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index recordings_user_id_idx on recordings (user_id);

alter table users      enable row level security;
alter table sessions   enable row level security;
alter table recordings enable row level security;
