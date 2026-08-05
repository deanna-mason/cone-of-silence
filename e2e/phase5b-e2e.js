// e2e/phase5b-e2e.js
// Phase 5B acceptance: episode exchange over the cos-xfer channel, headless.
// Two hosts (A, B) hold a call, record a short REAL take together, A sends it
// to B (hashes verifying, manifest written last), then A sends a second,
// LARGER episode built from a synthetic disk fixture; the signaling server is
// killed mid-transfer (both engines park), respawned, and the call recovers
// with fresh peerIds — proving the resume state lives entirely on disk, not
// in memory: previously-committed parts are never re-sent.
//
// Harness/bootstrap idiom copied from e2e/phase5a-e2e.js (login/vault-picker
// stubs, spawnServer, Chromium build selection) and e2e/phase2-e2e.js Check
// 13 (kill+respawn-in-place recovery — no fresh invite, no page reload).
//
// Run (macOS, node UNSANDBOXED — gUM hangs under this box's sandbox): have
// `next dev` on :3000 and nothing on :8787, then `node e2e/phase5b-e2e.js`.
//
// DEVIATIONS FROM THE BRIEF'S LITERAL CHECK TEXT (confirmed against the
// shipped, already-tested source and, for the peerId question, against the
// running app itself — not bugs introduced or fixed here):
//
// 1. The brief's setup note says the synthetic fixture is seeded by writing
//    directly into A's OPFS vault and "seed[ing] localStorage['cos-last-take']
//    with that takeId." Read literally that would mean forging a SECOND
//    takeId independent of the first real take. Two things rule that out:
//      a) hooks/usePodcastTake.ts's `lastTakeId` React state is set exactly
//         once per real take, from inside stopRecorders() (`setLastTakeId
//         (takeId)`), and separately read from localStorage exactly once, on
//         mount (`readLastTakeId()` inside a `useEffect(..., [])`). There is
//         no storage-event listener and no re-read path — writing
//         localStorage after mount is inert; the hook will never see it.
//      b) Even if it were live, reusing the FIRST take's takeId for the
//         fixture would collide with real names: EpisodeReceiver.adopt()
//         (lib/podcast/transfer.ts) rebuilds `have` via a bare
//         episodeStore.scanCommitted() — a directory listing keyed on NAME
//         only, never content. If the fixture reused "audio.part000" (the
//         real take's own committed name from the first send), B would
//         report that name as already-had, the sender would skip
//         re-sending it, and the final manifest would claim a sha256 for
//         that name that the actual on-disk bytes (the OLD real recording)
//         don't have — silent corruption, not a resume.
//    So: the fixture is written into a SECOND, freshly-minted take
//    directory. It's minted the same way the real app mints one — a second
//    short real roll+cut — which is also what actually calls
//    writeLastTakeId()/setLastTakeId() under the hood; no direct localStorage
//    poke is needed or would work. That take's tiny real audio/video parts
//    are then OVERWRITTEN with the synthetic fixture (same file names,
//    createWritable() truncates) before Send Episode is pressed — "a
//    synthetic fixture, not a live recording" for the BYTES that actually
//    cross the wire, exactly as the brief intends, without the name
//    collision.
// 2. The brief's step 6 says "A's panel shows Resume Transmission -> click".
//    Verified directly (throwaway probe script, not committed) against the
//    real app: killing+respawning the signaling server assigns BOTH hosts
//    brand-new server-side peerIds on rejoin (server/src/rooms/registry.ts
//    calls newPeerId() on every join/create — nothing persists one across a
//    process restart), even though it's the SAME room/URL. That is exactly
//    the "fresh peerIds" the brief's own setup note predicts. But
//    useEpisodeExchange.ts's resend() (and the `canResend` it mirrors)
//    deliberately require the parked sender's bound peerId to still BE the
//    current single peer — "resend fires at departed peerId" was fixed
//    during Task 11's review specifically to bail in this situation. So
//    canResend is false and "Resume Transmission" correctly does NOT render
//    after this kind of recovery (only a same-peerId 4C link rebuild, Task
//    8's scenario, keeps it available). This script asserts that absence
//    (a real regression would be Resume silently reappearing at a stale
//    peer) and drives the actual recovery path instead: Stand Down (dismiss
//    the parked sender), then Send Episode again. That path constructs a
//    brand-new EpisodeSender the same way resend() would have — start() ->
//    xfr/offer -> the receiver's disk-scanned `have` response is what
//    supplies resumedParts and skips already-committed parts either way, so
//    the "disk-only resume state" the brief is actually testing is identical
//    on both paths; only the button differs.
// 3. resumedParts (>=1 after the resume) lives on the SENDER's debug mirror
//    only — hooks/useEpisodeExchange.ts's `debug` object reports
//    `resumedParts: null` unconditionally on the receiver branch (only
//    SendProgress carries it; ReceiveProgress does not). This script reads
//    it from A (the sender), not B, matching the shipped field.
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const BASE = "http://localhost:3000";
const PORT = 8787;
const ADMIN_SECRET = "phase5b-e2e-secret-0123456789";
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const VAULT_DIR_NAME = "cos-vault";
const INCOMING_PREFIX = ".incoming-"; // mirrors lib/podcast/episodeStore.ts's INCOMING_PREFIX

// ~8 MiB/part x 3 parts x 2 streams = ~48 MiB total (brief's own sizing) —
// big enough that the server-kill lands mid-transfer reliably (backpressure
// alone guarantees several drain cycles per part at XFER_HIGH_WATER's 4 MiB,
// lib/webrtc/peer.ts) without inflating the gate's runtime unreasonably.
const FIXTURE_PART_BYTES = 8 * 1024 * 1024;
const FIXTURE_PARTS_PER_STREAM = 3;

const SHELL_ROOT = path.join(os.homedir(), "Library/Caches/ms-playwright");
// Pick the HIGHEST cached revision — see phase2/phase5a's header for why.
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

/** A logged-in host: session seeded, the Vault picker stub
 *  (window.showDirectoryPicker -> an OPFS subdirectory) — same idiom as
 *  e2e/phase5a-e2e.js's newHostPage — AND a narrow createDataChannel proxy
 *  that captures every "cos-xfer" channel (lib/webrtc/peer.ts creates it as
 *  a fixed-id negotiated channel, one per PeerLink) into
 *  window.__xferChannels. That gives waitXferChannelOpen below a DIRECT,
 *  provable "is the xfer channel actually open" signal — not the fuller
 *  RTCPeerConnection proxy phase5a/phase2 use (pcDebug), which this
 *  scenario doesn't otherwise need. */
async function newHostPage(browser, codename) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(
    ({ codename, vaultDirName }) => {
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
        if (typeof proto.queryPermission !== "function") {
          proto.queryPermission = async () => "granted";
        }
        if (typeof proto.requestPermission !== "function") {
          proto.requestPermission = async () => "granted";
        }
      }
      // The vault stub above is OPFS, where FileSystemFileHandle.move()
      // WORKS — but a real picked vault is a local directory, where Chrome
      // throws NotAllowedError (move-for-local-files is still flag-gated;
      // hit live 2026-08-03: zero inbound parts ever committed). Refusing
      // move() here makes this e2e exercise the SHIPPED path — episodeStore's
      // copy fallback — instead of an OPFS-only rename production never
      // runs (same D25 lesson as the E2EE harness workaround removal).
      // window.__moveRefusals proves the fallback actually engaged.
      window.__moveRefusals = 0;
      if (window.FileSystemFileHandle) {
        window.FileSystemFileHandle.prototype.move = async function () {
          window.__moveRefusals += 1;
          throw new DOMException(
            "The request is not allowed by the user agent or the platform in the current context.",
            "NotAllowedError",
          );
        };
      }
      window.__xferChannels = [];
      const realCreateDataChannel = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (label, opts) {
        const channel = realCreateDataChannel.call(this, label, opts);
        if (label === "cos-xfer") window.__xferChannels.push(channel);
        return channel;
      };
    },
    { codename, vaultDirName: VAULT_DIR_NAME },
  );
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
      reject(new Error(`signaling server exited early (code ${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  return child;
}

async function mintToken() {
  const res = await fetch(`http://localhost:${PORT}/admin/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify({ label: "phase5b-e2e" }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

// ---------------------------------------------------------------------
// __cosCall debug-mirror polling (app/room/page.tsx). `pod` is the take
// coordinator's own panel.kind (armed/rolling/etc — unaffected by an
// in-flight exchange). `xfer` is hooks/useEpisodeExchange.ts's `debug`:
// { kind, sentBytes, committedBytes, totalBytes, resumedParts } where kind
// is the RAW engine phase (offering/sending/receiving/parked/done/fault),
// not the "xfer-*" panel-state label — see the header deviation note 3 for
// resumedParts specifically.
// ---------------------------------------------------------------------
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

async function xferDebug(page) {
  return page.evaluate(() => window.__cosCall && window.__cosCall.xfer);
}

/** True readyState on the MOST RECENTLY created "cos-xfer" channel
 *  (window.__xferChannels, populated by newHostPage's createDataChannel
 *  proxy) — a rebuild after the kill+respawn constructs a brand-new
 *  RTCPeerConnection and channel, so "most recent" is "current". This is
 *  the direct proof hooks/useEpisodeExchange.ts's `xferOpen` (and therefore
 *  canSend/canResend) actually needs — not inferred from a timeout or from
 *  the unrelated main "cos" channel's dcOpen. */
function waitXferChannelOpen(page, timeoutMs) {
  return page.waitForFunction(
    () => {
      const chans = window.__xferChannels || [];
      const latest = chans[chans.length - 1];
      return !!latest && latest.readyState === "open";
    },
    { timeout: timeoutMs },
  );
}

// ---------------------------------------------------------------------
// OPFS introspection — each host's Vault lives at
// navigator.storage.getDirectory()/cos-vault/<takeId>/..., committed
// transfer parts under <takeId>/remote/ (lib/podcast/episodeStore.ts).
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

/** The vault accumulates one dir per roll — this scenario rolls twice on the
 *  same vault, so "find the take- dir" (phase5a's approach, safe there with
 *  only one roll) is ambiguous here. Diff against a snapshot taken before
 *  the roll instead: deterministic regardless of directory-iteration order. */
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

/** Committed remote parts only — excludes any .incoming-* temp, mirroring
 *  episodeStore.ts's own scanCommitted() filter. */
async function opfsRemoteEntries(page, takeDir) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, incomingPrefix }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      let remote;
      try {
        remote = await dir.getDirectoryHandle("remote");
      } catch {
        return [];
      }
      // "Committed" must mean CONTENT IN PLACE, not name visible: the
      // store's copy fallback (move() is refused on real vaults — and this
      // harness refuses it everywhere so the shipped path is what's under
      // test) creates the final name empty, streams into a sibling
      // <name>.crswap, and swaps on close(). So skip swap litter, skip any
      // name whose swap sibling is still live (commit in flight), and skip
      // 0-byte files (the create→createWritable micro-window). Name-only
      // filtering here raced an in-flight commit and failed check 6 on
      // mtime — the part was never re-sent; the sampler was just early.
      const names = [];
      for await (const [name] of remote.entries()) {
        names.push(name);
      }
      const out = [];
      for (const name of names) {
        if (name.startsWith(incomingPrefix)) continue;
        if (name.endsWith(".crswap")) continue;
        if (names.includes(`${name}.crswap`)) continue;
        const file = await (await remote.getFileHandle(name)).getFile();
        if (file.size === 0) continue;
        out.push(name);
      }
      return out;
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, incomingPrefix: INCOMING_PREFIX },
  );
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
        return { size: file.size, lastModified: file.lastModified };
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

/** Writes audio.part000..NNN + video.part000..NNN (random bytes) plus REAL
 *  sidecars (in-page crypto.subtle.digest, same hash the app itself uses)
 *  directly into a take dir — the "synthetic fixture" setup note. Overwrites
 *  whatever real (tiny) tape a short roll+cut already put there; a
 *  FileSystemWritableFileStream truncates on open, so no stale bytes survive
 *  past the new part's length. Returns { audio: SidecarEntry[], video:
 *  SidecarEntry[] } for later comparison against the manifest/receiver disk. */
async function seedSyntheticFixture(page, takeDir, partBytes, partsPerStream) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, partBytes, partsPerStream }) => {
      function toHex(buf) {
        return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
      }
      async function writePart(dir, name, size) {
        const bytes = new Uint8Array(size);
        const GEN_CHUNK = 65536; // crypto.getRandomValues' own per-call quota
        for (let off = 0; off < size; off += GEN_CHUNK) {
          crypto.getRandomValues(bytes.subarray(off, Math.min(off + GEN_CHUNK, size)));
        }
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
      const result = {};
      for (const base of ["audio", "video"]) {
        const parts = [];
        for (let i = 0; i < partsPerStream; i++) {
          parts.push(await writePart(dir, `${base}.part${String(i).padStart(3, "0")}`, partBytes));
        }
        const sidecarFh = await dir.getFileHandle(`${base}.sidecar.json`, { create: true });
        const w = await sidecarFh.createWritable();
        await w.write(JSON.stringify({ base, parts }));
        await w.close();
        result[base] = parts;
      }
      return result;
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, partBytes, partsPerStream },
  );
}

/** Roll -> wait rolling on both -> hold -> Cut -> wait armed on both. The
 *  "short REAL take" idiom from e2e/phase5a-e2e.js's Checks 3/6, generalized
 *  into one helper since this scenario needs it twice. */
async function rollAndCut(pageA, pageB, holdMs) {
  // The per-take headphones declaration resets on every return to armed —
  // answer it on BOTH sides before each roll (an undeclared acceptor
  // quiet-ignores the proposal; the proposer's button is disabled).
  await pageA.getByRole("button", { name: "Headphones In" }).click();
  await pageB.getByRole("button", { name: "Headphones In" }).click();
  await pageA.getByRole("button", { name: "Roll Tape" }).click();
  await Promise.all([waitPod(pageA, "rolling", 5000), waitPod(pageB, "rolling", 5000)]);
  await new Promise((r) => setTimeout(r, holdMs));
  await pageA.getByRole("button", { name: "Cut" }).click();
  await Promise.all([waitPod(pageA, "armed", 10000), waitPod(pageB, "armed", 10000)]);
}

/** Tight poll (no artificial delay between iterations — a small real take's
 *  transfer can be sub-second) that runs until B's remote/ holds every
 *  expected part AND the manifest is present. Gated on OPFS truth
 *  (committed-part COUNT), not the debug mirror's phase label: finishEpisode()
 *  (lib/podcast/transfer.ts) awaits writeManifest() to disk and ONLY THEN
 *  fires the "done" onPhase callback, so there's an inherent few-tick window
 *  where the manifest is already durable but the mirror still reads
 *  "receiving" — gating on phase==="done" instead produces a false positive
 *  there. Records whether the manifest was EVER observed while genuinely
 *  incomplete (non-vacuous — check 3 requires actually witnessing that
 *  window, not just a before/after snapshot) and whether it ever appeared
 *  before every part committed. */
async function pollManifestDuringTransfer(pageB, takeDir, expectedTotalParts, maxMs) {
  const start = Date.now();
  let observedInFlight = false;
  let manifestSeenWhileIncomplete = false;
  for (;;) {
    const [entries, manifest] = await Promise.all([
      opfsRemoteEntries(pageB, takeDir),
      opfsReadJSON(pageB, takeDir, "episode.json"),
    ]);
    if (entries.length < expectedTotalParts) {
      observedInFlight = true;
      if (manifest !== null) manifestSeenWhileIncomplete = true;
    } else if (manifest !== null) {
      return { observedInFlight, manifestSeenWhileIncomplete };
    }
    if (Date.now() - start > maxMs) {
      throw new Error(`timed out waiting for transfer #1 to finish (remote entries: ${JSON.stringify(entries)})`);
    }
  }
}

/** Tight poll for the interrupt leg: waits until B has committed at least
 *  one REAL part to remote/ (OPFS, not the debug mirror — ReceiveProgress.
 *  committedBytes tracks bytes appended to the CURRENT part, not bytes of
 *  fully committed parts, a known deferred imprecision, so a directory
 *  listing is the trustworthy signal here) while the transfer is still
 *  short of done. */
async function waitForFirstCommittedPart(pageB, takeDir, maxMs) {
  const start = Date.now();
  for (;;) {
    const [entries, xfer] = await Promise.all([opfsRemoteEntries(pageB, takeDir), xferDebug(pageB)]);
    const kind = xfer && xfer.kind;
    if (entries.length >= 1 && kind !== "done") return entries;
    if (kind === "done") {
      throw new Error("fixture transfer completed before any part could be observed committed — increase FIXTURE_PART_BYTES");
    }
    if (Date.now() - start > maxMs) throw new Error("timed out waiting for the fixture transfer's first committed part");
  }
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-phase5b-e2e-"));
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

    const { context: ctxA, page: pageA } = await newHostPage(browser, CODENAME_A);
    const { context: ctxB, page: pageB } = await newHostPage(browser, CODENAME_B);

    await pageA.goto(`${BASE}/`);
    await pageA.evaluate((t) => localStorage.setItem("cos-create-token", t), token);

    // ---- Setup: A creates the room, B joins, mesh flows both ways ----
    await enterGreenRoomAndProceed(pageA, url);
    await pageA.getByRole("button", { name: "Burn & Leave" }).waitFor();
    await enterGreenRoomAndProceed(pageB, url);
    await pageB.getByRole("button", { name: "Burn & Leave" }).waitFor();
    await waitRemoteVideosFlowing(pageA, 1, 20000);
    await waitRemoteVideosFlowing(pageB, 1, 20000);
    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    await pageB.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    await figcaption(pageA, CODENAME_B).waitFor({ timeout: 10000 });
    await figcaption(pageB, CODENAME_A).waitFor({ timeout: 10000 });

    // ---- Setup: arm the Tape Vault on both ----
    await pageA.getByRole("button", { name: "Choose Tape Vault" }).click();
    await pageB.getByRole("button", { name: "Choose Tape Vault" }).click();
    await waitPod(pageA, "armed", 15000);
    await waitPod(pageB, "armed", 15000);

    // =====================================================================
    // Check 1: a short REAL take completes; A's panel offers Send Episode.
    // =====================================================================
    const priorA0 = await opfsTakeDirNames(pageA);
    await rollAndCut(pageA, pageB, 5000);
    const takeId1 = await newTakeDirName(pageA, priorA0);
    const podArmedA = await pageA.evaluate(() => window.__cosCall && window.__cosCall.pod);
    check(podArmedA === "armed", `A's __cosCall.pod === "armed" after the short real take (got "${podArmedA}")`);
    const sendVisible1 = await pageA.getByRole("button", { name: "Send Episode" }).isVisible();
    check(sendVisible1, "A's panel offers Send Episode after a real-recording take");

    // =====================================================================
    // Checks 2 & 3: A sends the real take. B reaches xfer-receiving then
    // both reach xfer-done; committed parts + episode.json land on B;
    // manifest is absent for the entire in-flight window (observed live).
    // =====================================================================
    await pageA.getByRole("button", { name: "Send Episode" }).click();
    await waitXfer(pageB, "receiving", 10000);
    check(true, "B reaches receiving phase after A sends the real take");

    // 5s hold << PART_TARGET_MS (60s, lib/podcast/vault.ts) — exactly one
    // part per stream, so "every part committed" is audio.part000 +
    // video.part000, i.e. 2 remote/ entries.
    const { observedInFlight, manifestSeenWhileIncomplete } = await pollManifestDuringTransfer(pageB, takeId1, 2, 30000);
    check(observedInFlight, "check 3: genuinely observed B mid-transfer (non-vacuous), with fewer than all parts committed");
    check(!manifestSeenWhileIncomplete, "check 3: episode.json did NOT exist at any point before every part was committed");

    // pollManifestDuringTransfer only proves B's OPFS state reached "every
    // part committed + manifest present" — finishEpisode() (transfer.ts)
    // fires the "done" onPhase callback strictly AFTER that disk write, so
    // both mirrors still need their own explicit wait to actually verify
    // "both reach xfer-done", not just infer it from B's disk state.
    await Promise.all([waitXfer(pageA, "done", 10000), waitXfer(pageB, "done", 10000)]);
    check(true, "check 2: A and B both reach xfer-done for the real take");

    const remote1 = await opfsRemoteEntries(pageB, takeId1);
    check(
      remote1.includes("audio.part000") && remote1.includes("video.part000"),
      `check 2: B's remote/ has audio.part000 + video.part000 committed (got ${JSON.stringify(remote1)})`,
    );
    const manifest1 = await opfsReadJSON(pageB, takeId1, "episode.json");
    check(manifest1 !== null, "check 2: episode.json exists on B after xfer-done");

    // The init script refuses every move() with NotAllowedError (the real
    // picked-vault behavior) — so this completed transfer PROVES the copy
    // fallback, the shipped path, carried every commit. A zero here means
    // the patch silently stopped applying and the run regressed to
    // OPFS-only rename coverage.
    const refusalsB = await pageB.evaluate(() => window.__moveRefusals);
    check(
      typeof refusalsB === "number" && refusalsB >= 3,
      `check 2: B committed via the copy fallback — move() was refused for both parts + manifest (refusals: ${refusalsB})`,
    );
    if (manifest1) {
      const audioEntry1 = manifest1.remote?.audio?.find((p) => p.name === "audio.part000");
      check(!!audioEntry1, "check 2: manifest.remote.audio lists audio.part000");
      if (audioEntry1) {
        const actualHash1 = await opfsRemoteFileHash(pageB, takeId1, "audio.part000");
        check(
          actualHash1 === audioEntry1.sha256,
          `check 2: in-page hash of received audio.part000 matches its sidecar entry (${actualHash1} === ${audioEntry1.sha256})`,
        );
      }
    }

    await pageA.getByRole("button", { name: "Dismiss" }).click(); // dismiss A's xfer-done card (renamed from "File Away", 5fd9399)
    await waitPod(pageA, "armed", 5000);
    // 5fd9399's delivered state: after delivery the armed card shows a static
    // Episode Delivered marker and deliberately does NOT re-offer Send — a
    // fresh take (check 4's roll) is what re-arms it.
    const deliveredMarker = await pageA.getByText("◈ Episode Delivered").isVisible();
    const sendGoneAfterDelivery = !(await pageA.getByRole("button", { name: "Send Episode" }).isVisible());
    check(
      deliveredMarker && sendGoneAfterDelivery,
      "A dismisses the delivered card — armed shows Episode Delivered; Send re-arms only with a fresh take",
    );

    // =====================================================================
    // Check 4: a second short real roll+cut mints a FRESH takeId (the only
    // way lastTakeId's React state legitimately advances — see header
    // deviation note 1), whose disk content is then overwritten with the
    // synthetic fixture. A presses Send Episode -> sending begins.
    // =====================================================================
    // B's "Episode Received" card is still up — dismiss it so B's armed panel
    // (and its headphones declaration, which every new take now requires on
    // BOTH sides) is reachable before the next roll.
    await pageB.getByRole("button", { name: "Dismiss" }).click();
    await waitPod(pageB, "armed", 5000);

    const priorA1 = await opfsTakeDirNames(pageA);
    await rollAndCut(pageA, pageB, 3000);
    const takeId2 = await newTakeDirName(pageA, priorA1);
    check(takeId2 !== takeId1, `check 4 setup: a fresh takeId was minted for the fixture (${takeId2} !== ${takeId1})`);

    const fixture = await seedSyntheticFixture(pageA, takeId2, FIXTURE_PART_BYTES, FIXTURE_PARTS_PER_STREAM);
    check(
      fixture.audio.length === FIXTURE_PARTS_PER_STREAM && fixture.video.length === FIXTURE_PARTS_PER_STREAM,
      `check 4 setup: synthetic fixture seeded — ${fixture.audio.length} audio + ${fixture.video.length} video parts, ~${FIXTURE_PART_BYTES / 1_000_000}MB each`,
    );

    await pageA.getByRole("button", { name: "Send Episode" }).click();
    await pageA.waitForFunction(
      () => {
        const kind = window.__cosCall && window.__cosCall.xfer && window.__cosCall.xfer.kind;
        return kind === "offering" || kind === "sending";
      },
      { timeout: 10000 },
    );
    // B's debug mirror still reads the FIRST episode's stale "done" (it
    // never got dismissed) until B actually adopts this new offer — wait for
    // the real transition, or waitForFirstCommittedPart below could mistake
    // episode #1's leftover "done" for episode #2 finishing before it began.
    await waitXfer(pageB, "receiving", 10000);
    check(true, "check 4: A presses Send Episode on the fixture — sending begins, B adopts the new offer");

    // =====================================================================
    // Check 5: kill the signaling server once B has committed >=1 real
    // part but the transfer isn't done — both engines park (interrupted,
    // not an error card) and the call itself shows the 4C recovery banner.
    // =====================================================================
    const committedBeforeKill = await waitForFirstCommittedPart(pageB, takeId2, 60000);
    check(committedBeforeKill.length >= 1, `check 5 setup: B has committed >=1 fixture part before the kill (${JSON.stringify(committedBeforeKill)})`);

    // Snapshot every already-committed part's OPFS lastModified NOW, before
    // the kill — check 6 proves these bytes are never re-sent by asserting
    // they never get touched again.
    const preKillMeta = {};
    for (const name of committedBeforeKill) {
      preKillMeta[name] = await opfsRemoteFileMeta(pageB, takeId2, name);
    }

    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 3000);
    });

    await Promise.all([waitXfer(pageA, "parked", 8000), waitXfer(pageB, "parked", 8000)]);
    check(true, "check 5: server killed mid-transfer — BOTH engines reach parked (interrupted), not a fault");

    await pageA.getByText("Signal lost — re-establishing…").waitFor({ timeout: 20000 });
    await pageB.getByText("Signal lost — re-establishing…").waitFor({ timeout: 20000 });
    check(true, "check 5: the call itself shows the 4C recovery story on both sides");

    const interruptedTextA = await pageA.getByText("Transmission Interrupted").isVisible();
    const interruptedTextB = await pageB.getByText("Transmission Interrupted").isVisible();
    check(interruptedTextA && interruptedTextB, "check 5: Transmission Interrupted card shown on both panels (parked, not an error)");

    // =====================================================================
    // Check 6: respawn -> both recover the call with fresh peerIds (phase2
    // Check-13 pattern). See header deviation note 2: canResend correctly
    // requires the SAME peer, so Resume Transmission does NOT (and should
    // not) reappear here — assert that, then drive the real recovery path
    // (Stand Down -> Send Episode) and prove the resume is disk-driven.
    // =====================================================================
    server = await spawnServer(tokenFile);
    await pageA.getByText("Agents present: 2").waitFor({ timeout: 90000 });
    await pageB.getByText("Agents present: 2").waitFor({ timeout: 90000 });
    await waitRemoteVideosFlowing(pageA, 1, 30000);
    await waitRemoteVideosFlowing(pageB, 1, 30000);
    check(true, "check 6: server respawned — both pages recover the call, video flows again");

    // Proof, not a guess: canResend (hooks/useEpisodeExchange.ts:413) is
    // `senderPeerRef.current === singlePeerId && xferOpen` — a conjunction.
    // Without first PROVING xferOpen is true, an absent Resume button could
    // just as easily mean "the channel hasn't reopened yet", which would
    // never exercise the stale-peerId guard this check exists to catch.
    // waitXferChannelOpen reads the rebuilt "cos-xfer" channel's OWN
    // readyState directly, so by the time it resolves xferOpen is
    // definitely true — Resume being absent right after that can only be
    // the peerId mismatch.
    await waitXferChannelOpen(pageA, 15000);
    const resumeVisible = await pageA.getByRole("button", { name: "Resume Transmission" }).isVisible().catch(() => false);
    check(
      !resumeVisible,
      "check 6 (deviation note 2): Resume Transmission correctly absent while the xfer channel is provably open — the recovered peerId is fresh, not the parked sender's bound peer",
    );

    await pageA.getByRole("button", { name: "Dismiss" }).click();
    await waitPod(pageA, "armed", 5000);
    await pageA.getByRole("button", { name: "Send Episode" }).waitFor({ timeout: 5000 });
    await pageA.getByRole("button", { name: "Send Episode" }).click();
    check(true, "check 6: A dismisses the parked sender, then sends again at the fresh peer");

    await waitXfer(pageA, "done", 60000);
    await waitXfer(pageB, "done", 20000);
    check(true, "check 6: the resumed transfer completes on both sides");

    const debugA = await xferDebug(pageA);
    check(
      debugA !== null && debugA.resumedParts !== null && debugA.resumedParts >= 1,
      `check 6: A's (sender) debug mirror shows resumedParts >= 1 (got ${debugA && debugA.resumedParts}) — deviation note 3 on why this is A's field, not B's`,
    );

    let noPartsRewritten = true;
    for (const [name, before] of Object.entries(preKillMeta)) {
      const after = await opfsRemoteFileMeta(pageB, takeId2, name);
      const unchanged = !!after && !!before && after.lastModified === before.lastModified;
      if (!unchanged) noPartsRewritten = false;
      check(unchanged, `check 6: ${name}'s OPFS lastModified is unchanged since before the kill (${before && before.lastModified} -> ${after && after.lastModified}) — never re-sent`);
    }
    check(noPartsRewritten, "check 6: every part committed before the kill survived the resume untouched");

    // =====================================================================
    // Check 7: every fixture part exists in B's remote/ with sidecar-
    // matching sizes; episode.json parses with remote matching the offer
    // and local reflecting B's own (second, real) take state.
    // =====================================================================
    let allFixturePartsOk = true;
    for (const base of ["audio", "video"]) {
      for (const entry of fixture[base]) {
        const meta = await opfsRemoteFileMeta(pageB, takeId2, entry.name);
        const ok = !!meta && meta.size === entry.size;
        if (!ok) allFixturePartsOk = false;
        check(ok, `check 7: B's remote/${entry.name} exists with the sidecar-listed size ${entry.size} (got ${meta && meta.size})`);
      }
    }
    check(allFixturePartsOk, "check 7: every fixture part exists in B's remote/ with a sidecar-matching size");

    const manifest2 = await opfsReadJSON(pageB, takeId2, "episode.json");
    check(manifest2 !== null, "check 7: episode.json parses on B for the fixture episode");
    if (manifest2) {
      const remoteMatches =
        JSON.stringify(manifest2.remote?.audio) === JSON.stringify(fixture.audio) &&
        JSON.stringify(manifest2.remote?.video) === JSON.stringify(fixture.video);
      check(remoteMatches, "check 7: manifest.remote (audio + video) matches the fixture's own offer exactly");

      const bLocalAudio = await opfsReadJSON(pageB, takeId2, "audio.sidecar.json");
      const bLocalVideo = await opfsReadJSON(pageB, takeId2, "video.sidecar.json");
      const localMatches =
        JSON.stringify(manifest2.local?.audio) === JSON.stringify(bLocalAudio?.parts ?? []) &&
        JSON.stringify(manifest2.local?.video) === JSON.stringify(bLocalVideo?.parts ?? []);
      check(localMatches, "check 7: manifest.local reflects B's OWN (second, real) take state, untouched by A's fixture");
    }

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
