-- Professor-feedback polish: the DB is the last line of defense. token_hash
-- columns hold SHA-256 hex digests and nothing else — a CHECK makes it
-- impossible for a future code bug to store a raw token.

alter table creation_tokens
  add constraint creation_tokens_token_hash_format
  check (token_hash ~ '^[0-9a-f]{64}$');

alter table sessions
  add constraint sessions_token_hash_format
  check (token_hash ~ '^[0-9a-f]{64}$');
