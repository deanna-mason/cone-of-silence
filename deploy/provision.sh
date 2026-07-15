#!/usr/bin/env bash
# provision.sh — one-time setup of the cone-of-silence droplet.
# Run ON THE BOX as root: bash provision.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y

# 2 GB swap (1 GB droplet + ffmpeg need the headroom)
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Firewall: the Node port (8787) must NOT be reachable directly — Caddy fronts it.
apt-get install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Caddy 2 (official repo)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# ffmpeg (Phase 3B pipeline) + rsync (deploys)
apt-get install -y ffmpeg rsync

# App user + directories
id -u cos &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin cos
mkdir -p /opt/cone-of-silence/{server,models,uploads}
chown -R cos:cos /opt/cone-of-silence

echo "=== versions ==="
node -v; caddy version; ffmpeg -version | head -1
echo "=== arnndn available? ==="
ffmpeg -hide_banner -filters 2>/dev/null | grep arnndn || echo "MISSING arnndn — STOP and flag"
