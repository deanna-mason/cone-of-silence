#!/usr/bin/env bash
# keepalive.sh — daily read-only Supabase query so the free-tier project never
# pauses for 7-day inactivity (which took the site down on 2026-07-24).
# Installed to /opt/cone-of-silence/keepalive.sh + /etc/cron.d/cos-keepalive by deploy.sh.
set -euo pipefail
ENV_FILE=/opt/cone-of-silence/server/.env
URL=$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2-)
curl -sf --max-time 30 "$URL/rest/v1/creation_tokens?select=id&limit=1" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" >/dev/null
