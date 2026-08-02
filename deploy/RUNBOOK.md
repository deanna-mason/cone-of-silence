# Cone of Silence — Server Deploy Runbook

The server tier (Express + WebSocket signaling + ffmpeg jobs) runs on a single
DigitalOcean droplet behind Caddy (automatic Let's Encrypt TLS) at
**api.coneofsilence.app**. The frontend stays on Vercel. This file is enough to
rebuild the box from scratch.

## Encryption

E2EE: media frames and episode chunks are AES-GCM under keys derived from the never-sent URL-fragment secret; the droplet relays ciphertext only.

## The box

| Item | Value |
| --- | --- |
| Provider | DigitalOcean (paid directly, ~$6/mo — decided 2026-07-15) |
| Region | SFO3 (near Supabase us-west-2) |
| Image | Ubuntu 24.04 LTS x64 |
| Size | Basic Regular $6/mo — 1 GB RAM / 1 vCPU / 25 GB SSD + 2 GB swapfile |
| Hostname | cone-of-silence |
| Public IPv4 | 143.110.227.84 |
| SSH | `ssh root@143.110.227.84` (key `deanna-laptop`, ~/.ssh/id_ed25519) |

## DNS (Squarespace → Domains → coneofsilence.app → DNS)

| Host | Type | Data | TTL |
| --- | --- | --- | --- |
| api | A | 143.110.227.84 | 30 min |
| turn | A | 143.110.227.84 | 30 min |
| @ | A | 76.76.21.21 (Vercel) | 30 min |
| www | CNAME | cname.vercel-dns.com | 30 min |

Vercel treats **www.coneofsilence.app as the primary** frontend domain; the
apex 308-redirects to it. Both origins are in ALLOWED_ORIGINS.

`.app` is HSTS-preloaded: HTTPS-only by design; Caddy handles certs + the
80→443 redirect.

## Rebuild from scratch

1. Create droplet as above; add your SSH key.
2. `scp deploy/provision.sh root@<IP>: && ssh root@<IP> 'bash provision.sh'`
   — installs Node 22 (NodeSource), Caddy 2 (official repo), ffmpeg (verify
   `arnndn` in the output!), rsync, coturn, ufw (22/80/443, plus 3478 udp/tcp
   and 49160–49200/udp for TURN), 2 GB swap, creates system user `cos` and
   `/opt/cone-of-silence/{server,models,uploads}`.
3. Copy the RNNoise model (from the humanym pipeline folder on the laptop):
   `scp .../models/std.rnnn root@<IP>:/tmp/ && ssh root@<IP> 'mv /tmp/std.rnnn /opt/cone-of-silence/models/ && chown cos:cos /opt/cone-of-silence/models/std.rnnn'`
4. Create `/opt/cone-of-silence/server/.env` (mode 600, owner cos) with:
   `ADMIN_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (from the
   password manager / local `server/.env`), plus:
   `TOKEN_STORE=supabase`,
   `ALLOWED_ORIGINS=https://coneofsilence.app,https://www.coneofsilence.app,https://cone-of-silence.vercel.app,http://localhost:3000`,
   `PORT=8787`, `UPLOAD_DIR=/opt/cone-of-silence/uploads`,
   `RNNOISE_MODEL=/opt/cone-of-silence/models/std.rnnn`,
   `TURN_SECRET` (from password manager; generate with `openssl rand -hex 32`),
   `TURN_URLS=turn:turn.coneofsilence.app:3478?transport=udp,turn:turn.coneofsilence.app:3478?transport=tcp`
   (optional `TURN_TTL_SECONDS`, default 43200).
   Secrets are typed onto the box only — never committed.
5. `bash deploy/deploy.sh <IP>` — rsyncs `server/` + `lib/webrtc/protocol.ts`
   (the ws handler imports it at `../../../lib/webrtc/protocol.js`, so it must
   land at `/opt/cone-of-silence/lib/webrtc/protocol.ts`), chowns, `npm ci`
   as `cos`, restarts the service. Also writes `/etc/turnserver.conf`
   (committed template + `TURN_SECRET` appended from `.env`), restarts
   coturn, and installs the Supabase keepalive cron.
6. `scp deploy/cone-server.service root@<IP>:/tmp/ && scp deploy/Caddyfile root@<IP>:/tmp/`
   then on the box: move them to `/etc/systemd/system/` and
   `/etc/caddy/Caddyfile`, `systemctl daemon-reload`,
   `systemctl enable --now cone-server`, `systemctl reload caddy`.
7. Verify: `journalctl -u cone-server -n 5` shows "listening on :8787", and
   from anywhere:
   `curl -s https://api.coneofsilence.app/tokens/verify -X POST -H 'Content-Type: application/json' -d '{"token":"nope"}'`
   → `{"valid":false,"reason":"invalid"}` (proves DNS+TLS+Caddy+Node+Supabase).

## Routine deploy (after code changes)

```bash
bash deploy/deploy.sh 143.110.227.84
```

## Disk headroom

The droplet's 25 GB SSD holds the OS (~3 GB), swap (2 GB), and uploads.
Guards in the app: uploads are capped at 1 GiB per file and **2 GiB per
user total**, and the raw `source.*` file is deleted automatically after a
successful enhance — steady-state cost per recording is just
`enhanced.m4a` + `waveform.png`. Check headroom with:

```bash
ssh root@143.110.227.84 'df -h / && du -sh /opt/cone-of-silence/uploads'
```

If the disk ever fills anyway: find the biggest offenders with
`du -sh /opt/cone-of-silence/uploads/*`, and free space by deleting the
corresponding recordings from the Studio UI (which removes both the row
and the directory) rather than `rm`ing directories by hand.

## TURN verification

On the box (uses the real secret, exercises allocate → relay):

    SECRET=$(grep '^TURN_SECRET=' /opt/cone-of-silence/server/.env | cut -d= -f2-)
    turnutils_uclient -y -W "$SECRET" 127.0.0.1

Expected: allocation and authentication succeed ("Total transmit time" stats), but relayed echo data is intentionally dropped by denied-peer-ip (100% lost packets = the loopback guardrail working).
Negative check (stale/bogus creds must be REJECTED):

    turnutils_uclient -y -u bogus -w bogus 127.0.0.1

Expected: 401/allocation failure. From a browser: open a room with
`?forceTurn=1` — the call must still connect (relay-only), and
`chrome://webrtc-internals` shows the selected candidate pair type `relay`.
Note: `?forceTurn=1` does not survive a page refresh (fragment re-entry
drops the query string) — re-append it to the URL after any refresh.
Health: `systemctl is-active coturn` alongside the existing checks.
Episode exchange over a relayed call moves ~3 GB through coturn per episode (DTLS-encrypted, never stored) — ≈3‰ of the droplet's monthly transfer budget.

## Supabase keepalive

Daily cron `/etc/cron.d/cos-keepalive` runs `/opt/cone-of-silence/keepalive.sh`
(read-only `creation_tokens` select) — if the Supabase project ever pauses
again, check `grep cos-keepalive /var/log/syslog` first.

## Vercel (frontend) env — set BEFORE pushing frontend changes that need them

- `NEXT_PUBLIC_API_URL=https://api.coneofsilence.app`
- `NEXT_PUBLIC_SIGNALING_URL=wss://api.coneofsilence.app/ws`

## Known limitations (Phase 3A)

- Server logs: `journalctl -u cone-server -f`. Caddy/TLS logs:
  `journalctl -u caddy -f`.
