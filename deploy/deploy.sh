#!/usr/bin/env bash
# deploy.sh — rsync the server tier to the box and restart it.
# Usage: bash deploy/deploy.sh <host>
set -euo pipefail
HOST="${1:?usage: deploy.sh <host>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Server package + the shared protocol types it imports from ../../../lib/.
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env --exclude models \
  "$REPO_ROOT/server/" root@"$HOST":/tmp/cos-server/
rsync -az \
  "$REPO_ROOT/lib/webrtc/protocol.ts" root@"$HOST":/tmp/cos-protocol.ts
rsync -az "$REPO_ROOT/deploy/turnserver.conf" root@"$HOST":/tmp/cos-turnserver.conf
rsync -az "$REPO_ROOT/deploy/keepalive.sh" root@"$HOST":/tmp/cos-keepalive.sh

ssh root@"$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
rsync -a --delete --exclude .env --exclude node_modules --exclude data /tmp/cos-server/ /opt/cone-of-silence/server/
mkdir -p /opt/cone-of-silence/lib/webrtc
mv /tmp/cos-protocol.ts /opt/cone-of-silence/lib/webrtc/protocol.ts
chown -R cos:cos /opt/cone-of-silence
cd /opt/cone-of-silence/server
sudo -u cos npm ci --no-audit --no-fund
systemctl restart cone-server 2>/dev/null || echo "(cone-server unit not installed yet — first deploy)"
# TURN: committed config + secret appended from the server .env (single source).
if grep -q '^TURN_SECRET=' /opt/cone-of-silence/server/.env 2>/dev/null; then
  SECRET=$(grep '^TURN_SECRET=' /opt/cone-of-silence/server/.env | cut -d= -f2-)
  { cat /tmp/cos-turnserver.conf; echo "static-auth-secret=$SECRET"; } > /etc/turnserver.conf
  chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
else
  echo "(TURN_SECRET not in .env — coturn left unconfigured)"
fi
rm -f /tmp/cos-turnserver.conf
# Supabase keepalive: daily 04:17 UTC read-only query (see keepalive.sh header).
mv /tmp/cos-keepalive.sh /opt/cone-of-silence/keepalive.sh
chmod 755 /opt/cone-of-silence/keepalive.sh
printf '17 4 * * * root /opt/cone-of-silence/keepalive.sh >/dev/null 2>&1\n' > /etc/cron.d/cos-keepalive
REMOTE
echo "deployed to $HOST"
