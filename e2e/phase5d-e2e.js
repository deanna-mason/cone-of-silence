// e2e/phase5d-e2e.js
// Phase 5D acceptance: E2EE, headless. Two hosts (A, B) hold a call under the
// SAME room secret — join-proof proves both sides, media is pinned to VP9 and
// stays flowing while genuinely encrypted/decrypted (not merely "connected").
// A THIRD context joins the same room with a DIFFERENT secret and is refused
// without disturbing A or B. The signaling server is killed and respawned
// (phase2 Check-13 pattern) and the link rebuilds + re-proves from scratch.
// Finally a small episode exchange runs over cos-xfer with envelope
// encryption on, and a wiretap on the raw wire bytes proves the ciphertext
// never carries the plaintext.
//
// Harness/bootstrap idiom copied from e2e/phase5b-e2e.js (login/vault-picker
// stubs, spawnServer, kill+respawn-in-place recovery, the cos-xfer
// createDataChannel proxy idiom) and e2e/phase5a-e2e.js (EXECUTABLE
// resolution, launch args, mkRoomKeys/inviteUrl, the RTCPeerConnection-
// capturing Proxy idiom used here for getStats()).
//
// Run (macOS, node UNSANDBOXED — gUM hangs under this box's sandbox): have
// `next dev` on :3000 and nothing on :8787, then `node e2e/phase5d-e2e.js`.
//
// DEVIATIONS FROM THE BRIEF'S LITERAL CHECK TEXT (confirmed against the
// shipped, already-tested source — not bugs introduced or fixed here):
//
// 1. The brief sketches an instrumented `window.__cosE2ee.framesEncrypted/
//    Decrypted` counter, posted by the worker via postMessage and gated on a
//    `?e2edebug=1` search param. That counter does not exist anywhere in the
//    shipped Tasks 1-6 source (checked lib/webrtc/e2ee.worker.ts, peer.ts,
//    session.ts, hooks/useCallSession.ts, app/room/page.tsx — none of them
//    reference `__cosE2ee`, `e2edebug`, or any debug postMessage beyond the
//    worker's existing `{op:"error",...}` failure report). Task 7's own File
//    Structure / plan entry lists only `e2e/phase5d-e2e.js` and two doc edits
//    for this task — not a modification to any of those four already-
//    reviewed, already-unit-tested production files. Rather than bolt a new,
//    always-wired (even if flag-gated) debug channel onto four files whose
//    every existing line has been through multiple review rounds (see the
//    commit log: c2f025e, 8e2fff5, 94d6047, d92f908, a2f5dde, 2608336), this
//    script uses a different, honest signal that needs ZERO production code
//    changes: real, standardized `RTCStatsReport` fields (getStats(), the
//    same API Check 2 already uses), read from a harness-side
//    RTCPeerConnection-capturing Proxy — the exact `window.__pcs` idiom
//    phase5a-e2e.js's newHostPage/newGuestPage already use, just applied here
//    to stats instead of connection-state polling.
//
//    Specifically: inbound-rtp (video) `framesDecoded` is DOWNSTREAM of the
//    receiver-side decrypt transform (peer.ts's ontrack -> attachReceiverTransform
//    -> the worker's decrypt TransformStream -> frameCipher.decryptFrame) — a
//    frame that fails to decrypt is DROPPED before the decoder ever sees it
//    (fail-closed, Global Constraints), so `framesDecoded` stalling is
//    exactly what a broken/false encryption path would look like. A
//    strictly-increasing `framesDecoded` count while video is VISIBLY
//    flowing (already required by waitRemoteVideosFlowing's videoWidth>0
//    check) is real, non-fabricated evidence the decrypt pipeline is alive
//    and CONTINUING to succeed — not just "a call connected once". Outbound
//    (video) `framesSent`/`framesEncoded` is included alongside it as a
//    secondary "still producing frames" signal (it sits upstream of the
//    encrypt transform, so on its own it can't prove encryption specifically
//    — the receiver-side reading is this check's real teeth).
//
// 2. The brief's Check 5 wants "the two pcs' IV prefixes differ pre/post
//    rebuild (assert via the debug mirror)". The IV prefix is a random value
//    generated INSIDE the worker (frameCipher's IvState, constructed at pipe
//    setup) and never posted anywhere or placed on the wire in the shipped
//    code — producing that visibility needs the same missing debug
//    instrumentation as deviation 1. That specific property is also already
//    exhaustively unit-tested where it actually lives:
//    __tests__/crypto-frame.test.ts ("two IvStates have different prefixes")
//    and __tests__/e2ee-peer.test.ts (fresh worker per PeerLink construction)
//    — re-deriving a unit-pinned primitive property at the e2e layer adds
//    little. What this e2e layer CAN and SHOULD prove instead is the
//    INTEGRATION claim built on top of that primitive: a real signaling
//    kill+respawn really does construct a genuinely fresh RTCPeerConnection
//    (and therefore, by the peer.ts construction path, a fresh Worker and a
//    fresh IvState) end to end, and the rebuilt link's decrypt pipeline
//    really does resume working. This script asserts exactly that: the
//    harness's own __pcs Proxy captures every RTCPeerConnection the page
//    constructs, so a rebuild is provable by object identity (the pc used
//    after respawn is NOT the pc used before it — the Proxy needs no
//    production code changes to see this), and framesDecoded is sampled
//    again on the NEW pc to confirm decryption is genuinely live on it, not
//    just that a new object exists.
//
// 3. (D25, 2026-08-01 — superseded a prior harness workaround, kept here as
//    the record of WHY.) This script no longer forces any particular
//    transform API — it lets lib/webrtc/e2eeSupport.ts's detectE2eeApi() run
//    exactly as production does. That's the point of this note: what
//    follows is what this gate found, and it's WHY detectE2eeApi() now
//    prefers "encoded-streams" (see that file's own D25 doc comment).
//
//    Root-caused live, empirically, in an earlier run of this investigation:
//    with "script-transform" selected (chrome-headless-shell's
//    `RTCRtpScriptTransform` IS present, so feature-detection used to pick
//    it first), `scope.onrtctransform` fired correctly for BOTH sides
//    (confirmed via a throwaway instrumented build) and the SENDER side
//    genuinely encrypted (outbound framesEncoded/bytesSent climbed
//    normally) — but the RECEIVER side's transform stream's `transform()`
//    callback was NEVER invoked for a single frame, on either host, for the
//    life of the call: zero drops, zero errors, inbound-rtp `framesDecoded`
//    pinned at exactly 0 forever while `framesReceived`/`packetsReceived`
//    climbed normally (frames reached the jitter buffer, never reached the
//    decoder). Forcing the legacy `encoded-streams` API made video flow
//    immediately with no other change — isolating the fault to THIS BROWSER
//    BUILD's receiver-side RTCRtpScriptTransform plumbing, not to
//    lib/webrtc/peer.ts's or e2ee.worker.ts's usage of it (which mirrors the
//    standard WebRTC insertable-streams sample pattern byte for byte) and
//    not to lib/crypto/frameCipher.ts (already exhaustively round-trip-
//    tested). A receiver-side RTCRtpScriptTransform silently never
//    receiving frames is also an independently documented class of bug in
//    another engine (Firefox: bugzilla.mozilla.org/show_bug.cgi?id=1969603,
//    "Worker passed to RTCRtpScriptTransform never receives video frames
//    from the ReadableStream") — this API is genuinely fragile across
//    implementations, not something this codebase got wrong.
//
//    Deanna ruled (D25): prefer `createEncodedStreams` in production —
//    Chrome supports both APIs and podcast mode is Chrome-only, so nothing
//    is lost today; it's a one-line, fully reversible change; and it
//    removes the risk of a black-screen dress rehearsal. lib/webrtc/
//    e2ee.worker.ts's frame-flow timer (Task 7 review round 2 — unrelated to
//    lib/podcast/watchdog.ts's fault system) backstops whichever branch is
//    actually live, including the script-transform fallback, so a future
//    flip back isn't flying blind either.
//
//    WHAT THIS GATE PROVES NOW: with the harness workaround removed, this
//    script exercises the SHIPPED, PRODUCTION-PREFERRED path — detectE2eeApi()
//    picks "encoded-streams" here exactly as it will for a real user, not a
//    forced fallback. Every check below (proof, VP9 pin, continuous decode,
//    wrong-secret refusal, rebuild, encrypted exchange) is now coverage of
//    the actual default branch, closing the gap this note used to describe.
//    Whether script-transform's receiver-side behavior is sound on real
//    desktop Chrome remains open and is NOT this gate's concern any more
//    (it's the fallback, backstopped by the frame-flow timer) — that
//    question is Deanna's human two-Mac verification step's to answer, if
//    she ever needs to revisit D25.
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const BASE = "http://localhost:3000";
const PORT = 8787;
const ADMIN_SECRET = "phase5d-e2e-secret-0123456789";
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const VAULT_DIR_NAME = "cos-vault";

// Small fixture for Check 6 — big enough to span several 64 KiB xfer chunks
// (lib/podcast/xferProtocol.ts's XFER_CHUNK_BYTES) without inflating runtime;
// see seedMarkerFixture below.
const FIXTURE_PART_BYTES = 200_000;
const XFER_HEADER_BYTES = 20; // mirrors lib/podcast/xferProtocol.ts's XFER_HEADER_BYTES
const PLAINTEXT_MARKER = "COS-5D-E2E-PLAINTEXT-MARKER-DO-NOT-LEAK";

const SHELL_ROOT = path.join(os.homedir(), "Library/Caches/ms-playwright");
const shellDir = fs
  .readdirSync(SHELL_ROOT)
  .filter((d) => d.startsWith("chromium_headless_shell"))
  .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))[0];
const EXECUTABLE = path.join(SHELL_ROOT, shellDir, "chrome-headless-shell-mac-x64/chrome-headless-shell");

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${msg}`);
  if (!ok) failures++;
};

function mkRoomKeys() {
  return {
    roomId: crypto.randomBytes(16).toString("base64url"),
    secret: crypto.randomBytes(16).toString("base64url"),
  };
}

function inviteUrl({ roomId, secret }) {
  return `${BASE}/room#r=${roomId}&s=${secret}`;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function figcaption(page, text) {
  return page.locator("figcaption", { hasText: text });
}

/** A logged-in host: session seeded, the Vault picker stub (phase5a/5b
 *  idiom), PLUS two harness-only wiretaps, neither of which touches any
 *  production file (see the header's deviation notes):
 *   - window.__pcs: every RTCPeerConnection the page constructs, in
 *     construction order (phase5a-e2e.js's exact Proxy idiom) — used for
 *     getStats() (Checks 2, 3, 5).
 *   - a "cos-xfer" send() wiretap (extends phase5b-e2e.js's createDataChannel
 *     proxy): every binary chunk this page SENDS over cos-xfer is inspected
 *     in-page for the envelope's `enc` byte and for `marker` (Check 6) — no
 *     buffers are shipped back to Node, only booleans/counts, since the
 *     fixture's ciphertext bytes are large and uninteresting to inspect from
 *     outside the page. */
async function newHostPage(browser, codename, marker) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(
    ({ codename, vaultDirName, marker }) => {
      // D25 (see header note 3): no transform API is forced here any more —
      // detectE2eeApi() runs exactly as production does, which now selects
      // "encoded-streams" first (the branch this gate actually proves).
      localStorage.setItem(
        "cos-session",
        JSON.stringify({ session: "e2e-fake", username: codename, expiresAt: "2030-01-01T00:00:00.000Z" }),
      );
      window.showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(vaultDirName, { create: true });
      };
      const proto = window.FileSystemDirectoryHandle && window.FileSystemDirectoryHandle.prototype;
      if (proto) {
        if (typeof proto.queryPermission !== "function") proto.queryPermission = async () => "granted";
        if (typeof proto.requestPermission !== "function") proto.requestPermission = async () => "granted";
      }

      // --- __pcs: RTCPeerConnection capture (phase5a-e2e.js idiom) ---
      const RealPC = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = new Proxy(RealPC, {
        construct(target, args) {
          const pc = new target(...args);
          window.__pcs.push(pc);
          return pc;
        },
      });

      // --- cos-xfer wiretap (extends phase5b-e2e.js's channel-capture idiom) ---
      window.__xferChannels = [];
      window.__xferBinaryChunksSeen = 0;
      window.__xferBadEncSeen = false; // any observed chunk with enc !== 1
      window.__xferMarkerSeen = false; // the plaintext marker, found on the WIRE (should never happen)
      const markerBytes = marker ? new TextEncoder().encode(marker) : null;
      function containsMarker(view) {
        if (!markerBytes || markerBytes.length === 0) return false;
        outer: for (let i = 0; i <= view.length - markerBytes.length; i++) {
          for (let j = 0; j < markerBytes.length; j++) {
            if (view[i + j] !== markerBytes[j]) continue outer;
          }
          return true;
        }
        return false;
      }
      const realCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
        const channel = realCreateDataChannel.call(this, label, opts);
        if (label === "cos-xfer") {
          window.__xferChannels.push(channel);
          const realSend = channel.send.bind(channel);
          channel.send = function (data) {
            if (data instanceof ArrayBuffer) {
              const view = new Uint8Array(data);
              window.__xferBinaryChunksSeen += 1;
              if (containsMarker(view)) window.__xferMarkerSeen = true;
              // Envelope header (lib/podcast/xferProtocol.ts's encodeChunk):
              // [u8 version][u8 enc][u16 reserved][u32 seq LE][12-byte IV].
              if (view.length >= 20 && view[1] !== 1) window.__xferBadEncSeen = true;
            }
            return realSend(data);
          };
        }
        return channel;
      };
    },
    { codename, vaultDirName: VAULT_DIR_NAME, marker: marker ?? null },
  );
  return { context, page: await context.newPage() };
}

/** A plain call participant — no podcast auth, no vault stub, no wiretaps.
 *  Used for Check 4's wrong-secret third context: this scenario tests
 *  call-level (join-proof) security, which is independent of podcast mode —
 *  mirrors phase5a-e2e.js's newGuestPage. */
async function newGuestPage(browser) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  return { context, page: await context.newPage() };
}

async function waitRemoteVideosFlowing(page, count, timeoutMs) {
  await page.waitForFunction(
    (expected) => {
      const figs = [...document.querySelectorAll("figure")].filter((f) => {
        const cap = f.querySelector("figcaption")?.textContent || "";
        return cap !== "You" && cap !== "Awaiting agent";
      });
      if (figs.length !== expected) return false;
      return figs.every((f) => {
        const v = f.querySelector("video");
        return !!v && v.videoWidth > 0;
      });
    },
    count,
    { timeout: timeoutMs },
  );
}

async function enterGreenRoomAndProceed(page, url) {
  await page.goto(url);
  await page.getByText("Check Your Cover").waitFor();
  await page.waitForSelector("video");
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.srcObject && v.srcObject.getVideoTracks().length > 0;
  });
  await page.getByRole("button", { name: "Enter the Cone" }).click();
}

async function spawnServer(tokenFile) {
  const bound = await portInUse(PORT);
  if (bound) {
    console.error("stop the dev server tier first");
    process.exit(1);
  }

  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_SECRET,
      TOKEN_STORE: "file",
      TOKEN_FILE: tokenFile,
      ALLOWED_ORIGINS: "http://localhost:3000",
      SUPABASE_URL: "http://127.0.0.1:1",
      SUPABASE_SERVICE_ROLE_KEY: "e2e-dummy-key",
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Review fix (Minor 5): without killing it, a server that never
      // reported "listening" (but is still alive) leaks past this reject —
      // an orphan still holding :8787 makes the NEXT run's portInUse()
      // precheck abort immediately, which is exactly the wrong failure mode
      // for a gate that must run twice consecutively.
      child.kill("SIGTERM");
      reject(new Error(`signaling server did not report listening within 15s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15000);
    const poll = setInterval(() => {
      if (stdout.includes(`listening on :${PORT}`)) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 100);
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      // Already exited on this path, but killing is harmless (no-op on a
      // dead pid) and keeps this branch symmetric with the timeout branch
      // above rather than relying on "this one happens to not need it".
      child.kill("SIGTERM");
      reject(new Error(`signaling server exited early (code ${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  return child;
}

async function mintToken() {
  const res = await fetch(`http://localhost:${PORT}/admin/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: JSON.stringify({ label: "phase5d-e2e" }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

function waitPod(page, value, timeoutMs) {
  return page.waitForFunction((v) => window.__cosCall && window.__cosCall.pod === v, value, { timeout: timeoutMs });
}

function waitXfer(page, value, timeoutMs) {
  return page.waitForFunction(
    (v) => window.__cosCall && window.__cosCall.xfer && window.__cosCall.xfer.kind === v,
    value,
    { timeout: timeoutMs },
  );
}

/** Roll -> wait rolling on both -> hold -> Cut -> wait armed on both
 *  (e2e/phase5b-e2e.js idiom). */
async function rollAndCut(pageA, pageB, holdMs) {
  // Per-take headphones declaration (echo-guard) — both sides, before each
  // roll; it resets on every return to armed.
  await pageA.getByRole("button", { name: "Headphones" }).click();
  await pageB.getByRole("button", { name: "Headphones" }).click();
  await pageA.getByRole("button", { name: "Roll Tape" }).click();
  await Promise.all([waitPod(pageA, "rolling", 5000), waitPod(pageB, "rolling", 5000)]);
  await new Promise((r) => setTimeout(r, holdMs));
  await pageA.getByRole("button", { name: "Cut" }).click();
  await Promise.all([waitPod(pageA, "armed", 10000), waitPod(pageB, "armed", 10000)]);
}

// ---------------------------------------------------------------------
// getStats() helpers — Checks 2, 3, 5. All read the LATEST captured pc
// (window.__pcs[__pcs.length - 1]): a 4C rebuild constructs a brand-new
// RTCPeerConnection, so "latest" is always "current" (mirrors phase5b-e2e.js's
// waitXferChannelOpen's identical "most recent channel" reasoning).
// ---------------------------------------------------------------------

async function videoCodecMimeTypes(page) {
  return page.evaluate(async () => {
    const pcs = window.__pcs || [];
    const pc = pcs[pcs.length - 1];
    if (!pc) return { outbound: null, inbound: null };
    const stats = await pc.getStats();
    const codecs = {};
    let outboundCodecId = null;
    let inboundCodecId = null;
    stats.forEach((r) => {
      if (r.type === "codec") codecs[r.id] = r.mimeType;
      if (r.type === "outbound-rtp" && r.kind === "video") outboundCodecId = r.codecId;
      if (r.type === "inbound-rtp" && r.kind === "video") inboundCodecId = r.codecId;
    });
    return {
      outbound: outboundCodecId ? codecs[outboundCodecId] : null,
      inbound: inboundCodecId ? codecs[inboundCodecId] : null,
    };
  });
}

async function videoFrameCounts(page) {
  return page.evaluate(async () => {
    const pcs = window.__pcs || [];
    const pc = pcs[pcs.length - 1];
    if (!pc) return { framesSent: null, framesDecoded: null };
    const stats = await pc.getStats();
    let framesSent = null;
    let framesDecoded = null;
    stats.forEach((r) => {
      if (r.type === "outbound-rtp" && r.kind === "video") framesSent = r.framesSent ?? r.framesEncoded ?? null;
      if (r.type === "inbound-rtp" && r.kind === "video") framesDecoded = r.framesDecoded ?? null;
    });
    return { framesSent, framesDecoded };
  });
}

async function pcCount(page) {
  return page.evaluate(() => (window.__pcs || []).length);
}

// ---------------------------------------------------------------------
// OPFS introspection (episode exchange, Check 6) — mirrors phase5b-e2e.js.
// ---------------------------------------------------------------------

async function opfsTakeDirNames(page) {
  return page.evaluate(async (vaultDirName) => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle(vaultDirName, { create: true });
    const out = [];
    for await (const [name] of vault.entries()) {
      if (name.startsWith("take-")) out.push(name);
    }
    return out;
  }, VAULT_DIR_NAME);
}

async function newTakeDirName(page, priorNames) {
  const names = await opfsTakeDirNames(page);
  const fresh = names.filter((n) => !priorNames.includes(n));
  if (fresh.length !== 1) {
    throw new Error(`expected exactly one new take dir, got ${JSON.stringify(fresh)} (all: ${JSON.stringify(names)})`);
  }
  return fresh[0];
}

async function opfsReadJSON(page, takeDir, fileName) {
  return page
    .evaluate(
      async ({ vaultDirName, takeDir, fileName }) => {
        const root = await navigator.storage.getDirectory();
        const vault = await root.getDirectoryHandle(vaultDirName);
        const dir = await vault.getDirectoryHandle(takeDir);
        const fh = await dir.getFileHandle(fileName);
        const file = await fh.getFile();
        return JSON.parse(await file.text());
      },
      { vaultDirName: VAULT_DIR_NAME, takeDir, fileName },
    )
    .catch(() => null);
}

async function opfsRemoteFileMeta(page, takeDir, name) {
  return page
    .evaluate(
      async ({ vaultDirName, takeDir, name }) => {
        const root = await navigator.storage.getDirectory();
        const vault = await root.getDirectoryHandle(vaultDirName);
        const dir = await vault.getDirectoryHandle(takeDir);
        const remote = await dir.getDirectoryHandle("remote");
        const fh = await remote.getFileHandle(name);
        const file = await fh.getFile();
        return { size: file.size };
      },
      { vaultDirName: VAULT_DIR_NAME, takeDir, name },
    )
    .catch(() => null);
}

async function opfsRemoteFileHash(page, takeDir, name) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, name }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      const remote = await dir.getDirectoryHandle("remote");
      const fh = await remote.getFileHandle(name);
      const file = await fh.getFile();
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, name },
  );
}

/** True iff the receiver's committed file (post-decrypt) contains `marker` —
 *  the round-trip half of Check 6's wiretap: ciphertext on the wire, real
 *  plaintext on disk after decrypt. */
async function opfsRemoteFileContainsMarker(page, takeDir, name, marker) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, name, marker }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      const remote = await dir.getDirectoryHandle("remote");
      const fh = await remote.getFileHandle(name);
      const file = await fh.getFile();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(await file.arrayBuffer());
      return text.includes(marker);
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, name, marker },
  );
}

/** Overwrites a just-minted take dir's audio.part000/video.part000 with a
 *  small fixture containing a known ASCII marker near the start, plus REAL
 *  sidecars (in-page crypto.subtle.digest, the same hash the app itself
 *  uses) — same "synthetic fixture over a freshly-minted real take dir"
 *  pattern as e2e/phase5b-e2e.js's seedSyntheticFixture (see its header
 *  deviation note 1 for why the takeId must come from a real roll+cut rather
 *  than a forged localStorage poke), just smaller and with a recognizable
 *  marker in place of pure random fill so Check 6's wiretap has something
 *  concrete to search for. */
async function seedMarkerFixture(page, takeDir, partBytes, marker) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, partBytes, marker }) => {
      function toHex(buf) {
        return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
      }
      async function writePart(dir, name, size, markerBytes) {
        const bytes = new Uint8Array(size);
        const GEN_CHUNK = 65536; // crypto.getRandomValues' own per-call quota
        for (let off = 0; off < size; off += GEN_CHUNK) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + GEN_CHUNK, size)));
        }
        bytes.set(markerBytes, 4); // a few bytes in, well within the first xfer chunk
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return { name, size, sha256: toHex(digest) };
      }
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir, { create: true });
      const markerBytes = new TextEncoder().encode(marker);
      const result = {};
      for (const base of ["audio", "video"]) {
        const part = await writePart(dir, `${base}.part000`, partBytes, markerBytes);
        const sidecarFh = await dir.getFileHandle(`${base}.sidecar.json`, { create: true });
        const w = await sidecarFh.createWritable();
        await w.write(JSON.stringify({ base, parts: [part] }));
        await w.close();
        result[base] = part;
      }
      return result;
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, partBytes, marker },
  );
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-phase5d-e2e-"));
  const tokenFile = path.join(tmpDir, "tokens.json");
  let server = null;
  let browser = null;

  const CODENAME_A = "e2ehostA";
  const CODENAME_B = "e2ehostB";

  try {
    server = await spawnServer(tokenFile);
    const token = await mintToken();

    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
        "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox,WebRtcHideLocalIpsWithMdns",
      ],
    });

    const keys = mkRoomKeys();
    const url = inviteUrl(keys);

    const { context: ctxA, page: pageA } = await newHostPage(browser, CODENAME_A, PLAINTEXT_MARKER);
    const { context: ctxB, page: pageB } = await newHostPage(browser, CODENAME_B, PLAINTEXT_MARKER);

    await pageA.goto(`${BASE}/`);
    await pageA.evaluate((t) => localStorage.setItem("cos-create-token", t), token);

    // ---- Setup: A creates the room, B joins under the SAME secret ----
    await enterGreenRoomAndProceed(pageA, url);
    await pageA.getByRole("button", { name: "Burn & Leave" }).waitFor();
    await enterGreenRoomAndProceed(pageB, url);
    await pageB.getByRole("button", { name: "Burn & Leave" }).waitFor();

    // =====================================================================
    // Check 1: join-proof proven both sides, remote videos flowing.
    //
    // No separate "proof status" is surfaced anywhere in the UI or a debug
    // mirror — but per the shipped source (lib/webrtc/session.ts's buildLink:
    // "onRemoteStream: (stream) => { if (proof.phase === 'proven')
    // ev.onRemoteStream(stream); else stashedStream = stream; }" and
    // mesh.ts's roster()/openChannels(), both filtered on `everProven`), a
    // remote stream can ONLY ever surface, and the roster/dcOpen aggregate
    // can ONLY ever count a peer, once that peer's join-proof has reached
    // "proven". So waitRemoteVideosFlowing succeeding on both sides, plus
    // dcOpen and the roster count both going true/2, IS direct proof both
    // sides proved each other — not an inferred side effect.
    // =====================================================================
    await waitRemoteVideosFlowing(pageA, 1, 20000);
    await waitRemoteVideosFlowing(pageB, 1, 20000);
    check(true, "check 1: both A and B reach flowing remote video — impossible without a proven join-proof (session.ts gates onRemoteStream on proof.phase==='proven')");

    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    await pageB.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    check(true, "check 1: dcOpen true on both — mesh.openChannels() counts only proven peers");

    await pageA.getByText("Agents present: 2").waitFor({ timeout: 10000 });
    await pageB.getByText("Agents present: 2").waitFor({ timeout: 10000 });
    const peersA1 = await pageA.evaluate(() => window.__cosCall.peers);
    const peersB1 = await pageB.evaluate(() => window.__cosCall.peers);
    check(peersA1 === 1 && peersB1 === 1, `check 1: roster count is exactly 1 on both sides (A=${peersA1}, B=${peersB1}) — mesh.roster() filters on everProven`);

    await figcaption(pageA, CODENAME_B).waitFor({ timeout: 10000 });
    await figcaption(pageB, CODENAME_A).waitFor({ timeout: 10000 });

    // ---- Setup: arm the Tape Vault on both (needed later for Check 6) ----
    await pageA.getByRole("button", { name: "Choose Tape Vault" }).click();
    await pageB.getByRole("button", { name: "Choose Tape Vault" }).click();
    await waitPod(pageA, "armed", 15000);
    await waitPod(pageB, "armed", 15000);

    // =====================================================================
    // Check 2: outbound AND inbound video codec is VP9 on both pcs, via
    // page.evaluate + getStats() — never chrome://webrtc-internals.
    // =====================================================================
    const codecsA = await videoCodecMimeTypes(pageA);
    const codecsB = await videoCodecMimeTypes(pageB);
    check(
      codecsA.outbound === "video/VP9" && codecsA.inbound === "video/VP9",
      `check 2: A's pc — outbound video codec VP9 (got ${codecsA.outbound}), inbound video codec VP9 (got ${codecsA.inbound})`,
    );
    check(
      codecsB.outbound === "video/VP9" && codecsB.inbound === "video/VP9",
      `check 2: B's pc — outbound video codec VP9 (got ${codecsB.outbound}), inbound video codec VP9 (got ${codecsB.inbound})`,
    );

    // =====================================================================
    // Check 3: real getStats() frame counters strictly increasing while
    // flowing — see the header's deviation note 1 for why this substitutes
    // for the brief's sketched window.__cosE2ee.framesEncrypted/Decrypted.
    // =====================================================================
    const c3t1A = await videoFrameCounts(pageA);
    const c3t1B = await videoFrameCounts(pageB);
    await new Promise((r) => setTimeout(r, 2500));
    const c3t2A = await videoFrameCounts(pageA);
    const c3t2B = await videoFrameCounts(pageB);
    check(
      c3t2A.framesDecoded > c3t1A.framesDecoded,
      `check 3: A's inbound-rtp framesDecoded strictly increasing (${c3t1A.framesDecoded} -> ${c3t2A.framesDecoded}) — the decrypt pipeline is continuously live, not just once-connected`,
    );
    check(
      c3t2B.framesDecoded > c3t1B.framesDecoded,
      `check 3: B's inbound-rtp framesDecoded strictly increasing (${c3t1B.framesDecoded} -> ${c3t2B.framesDecoded})`,
    );
    check(
      c3t2A.framesSent > c3t1A.framesSent,
      `check 3: A's outbound-rtp framesSent strictly increasing (${c3t1A.framesSent} -> ${c3t2A.framesSent})`,
    );
    check(
      c3t2B.framesSent > c3t1B.framesSent,
      `check 3: B's outbound-rtp framesSent strictly increasing (${c3t1B.framesSent} -> ${c3t2B.framesSent})`,
    );

    // =====================================================================
    // Check 4: a THIRD context joins the SAME room with a DIFFERENT secret.
    // D18/D24 (shipped, ratified after review — see session.ts's
    // checkCountersignFailed doc): the REFUSED joiner gets the
    // "Countersign Rejected" card and its session goes terminal
    // (signaling.stop()); the honest incumbents (A, B, who already proved
    // each other before C ever joined — everProvenAnyone latched true) get
    // NO card and are not interrupted at all. Both halves are asserted.
    // =====================================================================
    const wrongSecret = crypto.randomBytes(16).toString("base64url");
    const wrongUrl = inviteUrl({ roomId: keys.roomId, secret: wrongSecret });
    const { context: ctxC, page: pageC } = await newGuestPage(browser);
    await enterGreenRoomAndProceed(pageC, wrongUrl);
    // 45s, not 20s: by this point in the scenario A and B are each already
    // running a full live VP9 encode/decode pipeline, and C's join spins up
    // TWO brand-new ICE/DTLS negotiations (C-A, C-B) on top of that load —
    // observed empirically to occasionally take >20s under this sandbox's
    // shared CPU, with zero errors/failures logged on any side while
    // waiting (a genuine timing-bound wait, not a stuck/racy protocol path
    // — see this file's own header for how the underlying join-proof gating
    // was verified).
    await pageC.getByText("The Room Refused Your Papers").waitFor({ timeout: 45000 });
    check(true, "check 4: wrong-secret third joiner reaches the countersign-failed refusal card");
    const kickerC = await pageC.getByText("◈ Countersign Rejected").isVisible();
    check(kickerC, 'check 4: refusal card carries the "◈ Countersign Rejected" kicker');

    // Give any (incorrect) disturbance a moment to show up before asserting
    // its absence — settling window, not a fixed-length sleep gating success.
    await new Promise((r) => setTimeout(r, 2000));
    const cardOnA = await pageA.getByText("Countersign Rejected").isVisible().catch(() => false);
    const cardOnB = await pageB.getByText("Countersign Rejected").isVisible().catch(() => false);
    check(!cardOnA && !cardOnB, "check 4 (D18/D24): neither honest host shows the refusal card — only the refused joiner does");

    const peersA2 = await pageA.evaluate(() => window.__cosCall.peers);
    const peersB2 = await pageB.evaluate(() => window.__cosCall.peers);
    check(peersA2 === 1 && peersB2 === 1, `check 4: A/B roster count is still exactly 1 (A=${peersA2}, B=${peersB2}) — the wrong-secret joiner never enters the roster`);

    const figCountA = await pageA.evaluate(() => document.querySelectorAll("figure").length);
    const figCountB = await pageB.evaluate(() => document.querySelectorAll("figure").length);
    check(figCountA === 2 && figCountB === 2, `check 4: exactly 2 tiles on A and B (self + the one honest peer) — no third tile (got A=${figCountA}, B=${figCountB})`);

    await pageA.getByText("Agents present: 2").waitFor({ timeout: 2000 });
    await pageB.getByText("Agents present: 2").waitFor({ timeout: 2000 });
    check(true, "check 4: A/B's header still reads Agents present: 2 — undisturbed");

    await ctxC.close();

    // =====================================================================
    // Check 5: kill + respawn the signaling server (phase2 Check-13 pattern).
    // Links rebuild, re-proof runs, videos flow again, framesDecoded resumes
    // increasing on the rebuilt link. See the header's deviation note 2 for
    // why "IV prefixes differ" is proven via pc identity + resumed decrypt
    // liveness rather than exposing the worker's internal random bytes.
    //
    // Review fix (Important 2): none of "Agents present: 2", waitRemoteVideos
    // Flowing, or framesDecoded actually PROVES re-proof ran on the FRESH
    // link, even though earlier wording here claimed it did:
    //   - roster() filters on the STICKY `everProven` (mesh.ts) — a peer
    //     proven before the rebuild keeps its roster row through the
    //     re-proof window regardless of whether the fresh proof has settled
    //     yet, so "Agents present: 2" surviving proves nothing new here.
    //   - waitRemoteVideosFlowing's videoWidth>0 check can pass against a
    //     STALE <video> element still holding the old (ended) stream —
    //     videoWidth persists after a track ends, so this alone doesn't
    //     prove the NEW link's proof completed either.
    //   - transforms attach regardless of proof state (D16) — framesDecoded
    //     resuming says the rebuilt decrypt pipeline works, not that the
    //     APP trusts this peer again.
    // The actual re-proof-completed signal is `dcOpen`: mesh.ts's
    // openChannels() aggregate filters on the STRICT `proven` flag (reset to
    // false, unconditionally, on every fresh rising edge by session.ts's
    // buildLink — see mesh.setProven(peerId, false) there), so dcOpen going
    // true again after the respawn is a zero-production-change proof the
    // fresh link's join-proof actually completed. Asserted explicitly below.
    // =====================================================================
    const pcCountBeforeA = await pcCount(pageA);
    const pcCountBeforeB = await pcCount(pageB);

    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 3000);
    });

    await pageA.getByText("Signal lost — re-establishing…").waitFor({ timeout: 20000 });
    await pageB.getByText("Signal lost — re-establishing…").waitFor({ timeout: 20000 });
    check(true, "check 5: server killed — both pages show the 4C recovery story");

    server = await spawnServer(tokenFile);
    await pageA.getByText("Agents present: 2").waitFor({ timeout: 90000 });
    await pageB.getByText("Agents present: 2").waitFor({ timeout: 90000 });
    await waitRemoteVideosFlowing(pageA, 1, 30000);
    await waitRemoteVideosFlowing(pageB, 1, 30000);
    check(true, "check 5: server respawned — call recovers, roster shows both agents again, video visibly present");

    // The actual re-proof proof (Important 2 fix): dcOpen is gated on the
    // STRICT per-rising-edge `proven` flag, not the sticky `everProven` the
    // roster count above relies on — this can only be true again once the
    // fresh link's join-proof has genuinely completed.
    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true, { timeout: 15000 });
    await pageB.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true, { timeout: 15000 });
    check(true, "check 5: dcOpen is true again on both sides — the FRESH link's join-proof actually re-completed (strict `proven`, not sticky `everProven`)");

    const pcCountAfterA = await pcCount(pageA);
    const pcCountAfterB = await pcCount(pageB);
    check(
      pcCountAfterA > pcCountBeforeA && pcCountAfterB > pcCountBeforeB,
      `check 5: a genuinely NEW RTCPeerConnection was constructed for the rebuild on both sides (A: ${pcCountBeforeA}->${pcCountAfterA}, B: ${pcCountBeforeB}->${pcCountAfterB}) — by construction (peer.ts) this means a fresh Worker + fresh IvState too (already unit-pinned: crypto-frame.test.ts, e2ee-peer.test.ts)`,
    );

    const c5t1A = await videoFrameCounts(pageA);
    const c5t1B = await videoFrameCounts(pageB);
    await new Promise((r) => setTimeout(r, 2500));
    const c5t2A = await videoFrameCounts(pageA);
    const c5t2B = await videoFrameCounts(pageB);
    check(
      c5t2A.framesDecoded > c5t1A.framesDecoded,
      `check 5: framesDecoded resumes increasing on A's rebuilt link (${c5t1A.framesDecoded} -> ${c5t2A.framesDecoded})`,
    );
    check(
      c5t2B.framesDecoded > c5t1B.framesDecoded,
      `check 5: framesDecoded resumes increasing on B's rebuilt link (${c5t1B.framesDecoded} -> ${c5t2B.framesDecoded})`,
    );

    // =====================================================================
    // Check 6: a small episode exchange with E2EE on (every call is E2EE —
    // D15, no toggle exists). Completes, received parts hash-verify (5B's
    // own check, reused), and a raw cos-xfer wiretap confirms the wire never
    // carries the plaintext marker while the receiver's DECRYPTED file does
    // — proving genuine encrypt-on-wire / decrypt-on-receipt, not merely
    // "the transfer finished".
    // =====================================================================
    const priorTakeDirs = await opfsTakeDirNames(pageA);
    await rollAndCut(pageA, pageB, 3000);
    const takeId = await newTakeDirName(pageA, priorTakeDirs);
    const fixture = await seedMarkerFixture(pageA, takeId, FIXTURE_PART_BYTES, PLAINTEXT_MARKER);
    check(
      fixture.audio.size === FIXTURE_PART_BYTES && fixture.video.size === FIXTURE_PART_BYTES,
      `check 6 setup: marker fixture seeded — audio ${fixture.audio.size}B, video ${fixture.video.size}B`,
    );

    await pageA.getByRole("button", { name: "Send Episode" }).click();
    await Promise.all([waitXfer(pageA, "done", 30000), waitXfer(pageB, "done", 30000)]);
    check(true, "check 6: episode exchange completes on both sides");

    let hashesOk = true;
    for (const base of ["audio", "video"]) {
      const name = `${base}.part000`;
      const meta = await opfsRemoteFileMeta(pageB, takeId, name);
      const sizeOk = !!meta && meta.size === FIXTURE_PART_BYTES;
      const actualHash = await opfsRemoteFileHash(pageB, takeId, name);
      const hashOk = actualHash === fixture[base].sha256;
      if (!sizeOk || !hashOk) hashesOk = false;
      check(sizeOk, `check 6: B's remote/${name} size matches the fixture (${meta && meta.size} === ${FIXTURE_PART_BYTES})`);
      check(hashOk, `check 6: B's remote/${name} sha256 hash-verifies (${actualHash} === ${fixture[base].sha256})`);
    }
    check(hashesOk, "check 6: every received part hash-verifies");

    const manifest = await opfsReadJSON(pageB, takeId, "episode.json");
    check(manifest !== null, "check 6: episode.json exists on B after the exchange");

    const markerOnDiskAudio = await opfsRemoteFileContainsMarker(pageB, takeId, "audio.part000", PLAINTEXT_MARKER);
    const markerOnDiskVideo = await opfsRemoteFileContainsMarker(pageB, takeId, "video.part000", PLAINTEXT_MARKER);
    check(markerOnDiskAudio && markerOnDiskVideo, "check 6: the plaintext marker IS present in B's DECRYPTED committed files — genuine round-trip, not a pass-through");

    const chunksSeen = await pageA.evaluate(() => window.__xferBinaryChunksSeen);
    check(chunksSeen > 0, `check 6 setup: the wiretap actually captured binary cos-xfer chunks (${chunksSeen}) — non-vacuous`);
    const badEnc = await pageA.evaluate(() => window.__xferBadEncSeen);
    check(!badEnc, "check 6: every observed chunk envelope has enc===1 (AES-GCM) — no enc=0 plaintext downgrade on the wire");
    const markerOnWire = await pageA.evaluate(() => window.__xferMarkerSeen);
    check(!markerOnWire, "check 6: the plaintext marker is ABSENT from every raw cos-xfer chunk A actually sent — the wire carries ciphertext only");

    await ctxA.close();
    await ctxB.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => {
        server.once("exit", resolve);
        setTimeout(resolve, 3000);
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("SCRIPT ERROR:", err);
  process.exit(1);
});
