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

ssh root@"$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
rsync -a --delete --exclude .env --exclude node_modules --exclude data /tmp/cos-server/ /opt/cone-of-silence/server/
mkdir -p /opt/cone-of-silence/lib/webrtc
mv /tmp/cos-protocol.ts /opt/cone-of-silence/lib/webrtc/protocol.ts
chown -R cos:cos /opt/cone-of-silence
cd /opt/cone-of-silence/server
sudo -u cos npm ci --no-audit --no-fund
systemctl restart cone-server 2>/dev/null || echo "(cone-server unit not installed yet — first deploy)"
REMOTE
echo "deployed to $HOST"
