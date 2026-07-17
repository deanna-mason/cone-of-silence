-- Professor-feedback polish: recordings.updated_at is bookkeeping, so the DB
-- owns it — a moddatetime trigger stamps every UPDATE and the app stops
-- writing timestamps by hand.
--
-- Deliberately NOT applied to creation_tokens.last_used_at: that column is
-- semantically app-owned (only verify/redeem count as "use"; relabel and
-- revoke must not touch it).

create extension if not exists moddatetime with schema extensions;

create trigger recordings_set_updated_at
  before update on recordings
  for each row
  execute function extensions.moddatetime(updated_at);
