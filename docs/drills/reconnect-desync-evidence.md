# Evidence capture: the reconnect roster desync

For finding 1 of `2026-08-05-four-fix-redrill-report.md` — a wifi drop mid-transfer
left the two sides disagreeing about who was in the room, with no self-recovery.

**This is a capture run, not a fix run.** The goal is to record what the server
sends each side on the reconnect. Nothing gets patched until we can see it.

The single most important capture is **the WebSocket messages**, not
webrtc-internals. The "one agent vs two agents" disagreement is a signaling
problem — the roster is something the server *tells* each client. The WS
message log shows exactly what each side was told. webrtc-internals is the
secondary capture; it tells us what happened to the media link afterward.

---

## Before you start

Make a folder to collect everything:

```
mkdir -p ~/Desktop/drill-evidence
```

Reproduce condition: **an episode transfer must be in flight.** This did not
happen during plain wifi drops in blocks B and F — the transfer is what makes
it appear. So you need a take recorded first, then a send in progress.

---

## Setup — Deanna's Mac

1. Open `chrome://webrtc-internals` in **its own tab, and leave it open.**
   **It only records connections created while it is open** — if you open it
   after joining the call, it will be empty and the run is wasted.
2. In the tab you'll run the call in, open DevTools (⌥⌘I) **before joining**:
   - **Console** tab → click the gear icon → tick **Preserve log**
   - **Network** tab → tick **Preserve log** → click the **WS** filter
   - Leave DevTools open the whole run. Without Preserve log, the reconnect
     wipes exactly the evidence we need.
3. Join the room.
4. Click the WebSocket connection that appears in the Network list, then the
   **Messages** sub-tab. You should see signaling frames arriving. Confirm you
   can see them *before* going further.

## Setup — Lily's Mac

Same as steps 2–4 above (DevTools Console + Network/WS, both with Preserve
log, opened before joining). She does **not** need webrtc-internals — one side
is enough, and hers is the side that reconnects.

## Setup — the droplet

In a terminal:

```
ssh root@143.110.227.84
journalctl -u cone-server -f | tee /tmp/desync-$(date +%H%M).log
```

Leave it streaming. Note the filename it prints.

---

## The run

Keep a note of the **wall-clock time** at each step — this is what lets me line
up three separate logs. Just say the times out loud and write them down.

| # | Step | Note the time |
|---|---|---|
| 1 | Both join, record a short take (~60 s), Cut | |
| 2 | SEND EPISODE from one Mac | |
| 3 | Once the progress row is climbing, **Lily turns wifi OFF** | ← time |
| 4 | Wait for both sides to show signal-lost / the interrupted card | |
| 5 | **Lily turns wifi back ON.** Change nothing else — neither of you leaves the room | ← time |
| 6 | Wait a full 60 s. Do not leave, do not refresh, do not click anything | |
| 7 | Write down what each side shows: agent count, and what the card says | ← time |

If it recovers cleanly this time, say so — that is a real result too, and it
means the bug needs a tighter trigger to pin down.

---

## The capture (do this BEFORE anyone leaves the room)

Order matters — leaving the call closes the connection and some of this goes away.

**Deanna, in the webrtc-internals tab:**

1. Scroll to the bottom, expand **Create Dump**
2. Tick **Download the PeerConnection updates and stats data**
3. Click **Download** → save to `~/Desktop/drill-evidence/` as
   `webrtc-deanna.txt`

**Both Macs, in DevTools:**

4. **Network → WS → click the connection → Messages sub-tab** → right-click
   anywhere in the message list → **Save all as HAR with content** →
   `~/Desktop/drill-evidence/ws-deanna.har` (Lily: `ws-lily.har`)
5. **Console tab** → right-click in the log → **Save as...** →
   `~/Desktop/drill-evidence/console-deanna.log` (Lily: `console-lily.log`)

**Droplet:**

6. Ctrl-C the `journalctl`, then from your Mac:
   ```
   scp root@143.110.227.84:/tmp/desync-*.log ~/Desktop/drill-evidence/
   ```

**Lily** sends you her two files; drop them in the same folder.

Then tell me the folder is ready plus the times from the table, and I'll read
them.

---

## What I'm actually looking for

So this stops feeling like a black box:

**From the WS messages (the primary evidence).** On Lily's reconnect, I want
the join/roster frames the server sent each side. Specifically: did Lily's
side receive a roster listing Deanna at all, and did Deanna's side receive a
peer-left for Lily's old connection and a peer-joined for her new one? A
reconnect re-mints the peer id, so the failure is almost certainly one side
acting on an id the other has already retired. The frames say which.

**From webrtc-internals (the secondary evidence).** One question, mainly:
after Lily's reconnect, does Deanna's tab still hold the **old** PeerConnection,
or did it build a **new** one? Each connection is its own collapsible section
on that page, so the count answers it. Then, inside the relevant one, the
event timeline — whether it went `connected → disconnected → failed` or sat in
`disconnected` forever. That distinguishes "Deanna kept a stale link and never
noticed" from "a new link was attempted and failed to come up." Those need
opposite fixes, which is why I won't guess between them.

**From the server log.** Whether the server saw Lily's old socket close at all.
If her old connection lingered as a zombie, the room roster the server believed
in was wrong before either client did anything — that would move the fix to the
server, not the client.
