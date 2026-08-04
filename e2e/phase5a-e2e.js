// e2e/phase5a-e2e.js
// Phase 5A acceptance: podcast mode's rolling recorder, headless. Two hosts
// (A, B) hold a call, arm the Tape Vault, ROLL TAPE, record for real, survive
// a camera-kill mid-take, coordinate a stop, and the resulting part-files +
// sidecars in each host's Vault verify and byte-concatenate to a valid
// stream. A third context proves the "two chairs only" gate.
//
// Harness/bootstrap idiom copied from e2e/phase2-e2e.js: this script owns the
// signaling server's lifecycle (spawns it on :8787 with a throwaway file
// store + test-only admin secret, hermetic Supabase dummies), requires Next
// dev already serving :3000, and drives playwright-core against a pinned
// Chromium build.
//
// Chromium build: same chrome-headless-shell revision phase2 uses. Verified
// during development (throwaway smoke scripts, not committed) that this
// build fully supports what this scenario additionally needs — MediaRecorder
// H.264/VP8 + Opus WebM, OPFS, and the audio constraints recordGraph.ts
// asserts — AND that same-machine WebRTC connects on it. The full
// "chromium-<rev>" Chrome-for-Testing build was tried first and rejected:
// with WebRtcHideLocalIpsWithMdns disabled it reveals this machine's real
// LAN IP (not loopback) as the host candidate, and two same-machine peers
// dialing each other over that address never connect on this network (no
// NAT hairpin) — iceConnectionState wedges at "checking"/"disconnected"
// forever. The headless shell build reveals 127.0.0.1 instead, which is
// exactly the loopback behavior phase2's header comment describes and relies
// on, so this script uses it too.
//
// Run (macOS, node UNSANDBOXED — gUM hangs under this box's sandbox): have
// `next dev` on :3000 and nothing on :8787, then `node e2e/phase5a-e2e.js`.
//
// Vault picker cannot be automated: every host context stubs
// window.showDirectoryPicker to hand back an OPFS (navigator.storage.
// getDirectory()) subdirectory, which satisfies the real vault/writer code
// path (lib/podcast/vault.ts, lib/podcast/recorder.ts) end to end. Login is
// seeded by writing the `cos-session` localStorage key directly (client-side
// gate only — no server call in the recorder path).
//
// DEVIATIONS FROM THE BRIEF'S LITERAL CHECK TEXT (both confirmed against the
// shipped, already-tested source — not bugs introduced or fixed here; see
// task-10-report.md for the full account):
//
// 1. (RETIRED — the deviation is gone.) Check 5's "B's banner names A's
//    codename + CAMERA DROPPED" is now asserted literally. Watchdog row 5
//    carries the partner's own beacon cause as the remote fault's `detail`
//    (lib/podcast/watchdog.ts), and the panel renders CAUSE_COPY[detail]
//    (components/PodcastPanel.tsx), so B's banner reads "<codename>: CAMERA
//    DROPPED". The generic "REPORTS A FAULT" copy now applies only to a
//    partner who stopped rolling without naming a cause — check 5 asserts B's
//    banner does NOT show it.
// 2. Check 6's "A dismisses (Stand Down) -> B clicks Cut": B's own fault
//    banner (the remote partner-fault above) never self-clears, because
//    A's camera track is permanently ended — A's beacon keeps carrying
//    fault: "camera-lost" forever, so B's own evaluate() keeps reporting
//    partner-fault every tick. The "fault" panel state offers ONLY Stand
//    Down (components/PodcastPanel.tsx has no Cut button on that branch), so
//    B cannot reach the Cut button until B ALSO stands down. Adapted
//    sequence below: A stands down, B stands down, THEN B cuts.
// 3. Check 4/5's "OPFS introspection shows video.part000/audio.part000
//    growing": a FileSystemWritableFileStream is atomic-on-close by design
//    (vault.ts's own header note) — verified directly (throwaway smoke
//    script) that dir.getFileHandle(...).getFile().size reads 0 for an OPEN
//    part on THIS platform too (OPFS is no exception), all the way up to
//    PART_TARGET_MS (60s) rollover or take-end. A 5-10s take never sees that,
//    so a literal per-file size read cannot show growth. Check 4's PRIMARY
//    growth signal is now window.__cosCall.podBytes — a debug-mirror
//    extension (hooks/usePodcastTake.ts's `bytes`, app/room/page.tsx) of the
//    recorder's own bytes() counter, video and audio counted separately, on
//    BOTH contexts — because an aggregate byte total can't tell "both
//    streams growing" apart from "one stream stalled while the other
//    grows". navigator.storage.estimate().usage is kept alongside it as a
//    secondary, aggregate disk-truth signal (confirmed via the same smoke
//    script to reflect the writable stream's backing bytes as they're
//    written, before the atomic swap) — it's still honest OPFS introspection
//    (Storage API, this origin, this take), just not one that can localize a
//    stall to a single stream.
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const BASE = "http://localhost:3000";
const PORT = 8787;
const ADMIN_SECRET = "phase5a-e2e-secret-0123456789";
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const VAULT_DIR_NAME = "cos-vault";

const SHELL_ROOT = path.join(os.homedir(), "Library/Caches/ms-playwright");
// Pick the HIGHEST cached revision — a stale older build beside a newer one
// is incompatible with the installed playwright-core (see phase2's header).
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

async function pcDebug(page) {
  return page.evaluate(() =>
    (window.__pcs || []).map((pc) => ({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
    })),
  );
}

/** A plain call participant — no podcast auth, no vault stub. Used for the
 *  third-context "two chairs only" drill (check 2). */
async function newGuestPage(browser) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(() => {
    const Real = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = new Proxy(Real, {
      construct(target, args) {
        const pc = new target(...args);
        window.__pcs.push(pc);
        return pc;
      },
    });
  });
  return { context, page: await context.newPage() };
}

/** A logged-in host: session seeded, RTCPeerConnection debug mirror, AND the
 *  Vault picker stub (window.showDirectoryPicker -> an OPFS subdirectory).
 *  Each context's OPFS is isolated by Playwright storage partitioning, so A
 *  and B never collide on the "cos-vault" name. */
async function newHostPage(browser, codename) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(
    ({ codename, vaultDirName }) => {
      const Real = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = new Proxy(Real, {
        construct(target, args) {
          const pc = new target(...args);
          window.__pcs.push(pc);
          return pc;
        },
      });

      // Client-side gate only (getSession() in lib/authApi.ts) — no server
      // call in the recorder path, so a fabricated far-future session is
      // sufficient to unlock podcast mode.
      localStorage.setItem(
        "cos-session",
        JSON.stringify({ session: "e2e-fake", username: codename, expiresAt: "2030-01-01T00:00:00.000Z" }),
      );

      // The Vault picker cannot be automated. Hand back an OPFS-backed
      // subdirectory instead — the real writer code path (PartWriter,
      // openTakeDir) runs unmodified against it.
      window.showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(vaultDirName, { create: true });
      };
      // Defensive: patched at the PROTOTYPE level (not the instance) so it
      // also covers any handle re-fetched from IndexedDB, whose deserialize
      // does not carry instance-level monkeypatches. In practice this
      // machine's Chrome build already implements queryPermission/
      // requestPermission natively on OPFS handles and returns "granted", so
      // this is belt-and-braces rather than load-bearing.
      const proto = window.FileSystemDirectoryHandle && window.FileSystemDirectoryHandle.prototype;
      if (proto) {
        if (typeof proto.queryPermission !== "function") {
          proto.queryPermission = async () => "granted";
        }
        if (typeof proto.requestPermission !== "function") {
          proto.requestPermission = async () => "granted";
        }
      }
    },
    { codename, vaultDirName: VAULT_DIR_NAME },
  );
  return { context, page: await context.newPage() };
}

// Remote tiles are every figure except the self tile ("You") and the empty
// "Awaiting agent" placeholder. NOTE this departs from phase2-e2e.js's
// `/^Agent \d$/` label filter: here A and B are both logged in, so once the
// podcast hello handshake completes (fast — rides the data channel's rising
// edge) a two-peer remote tile's label swaps from "Agent 2" to the peer's
// CODENAME (app/room/page.tsx), which that regex would no longer match.
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

// Bounded join retries, kept as a backstop (see e2e/phase2-e2e.js for the
// full history of the app-side ICE-gathering bug this originally chased —
// fixed in lib/webrtc/mesh.ts; the retries just make a lost pair cheap to
// redo rather than a script assumption of perfection).
const MAX_CONNECT_ATTEMPTS = 3;
async function joinUntilFlowing(page, url, expectFlowing) {
  await enterGreenRoomAndProceed(page, url);
  await page.getByRole("button", { name: "Burn & Leave" }).waitFor();
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      for (const [p, n] of expectFlowing) await waitRemoteVideosFlowing(p, n, 20000);
      return;
    } catch (err) {
      if (attempt === MAX_CONNECT_ATTEMPTS) {
        for (const [p] of expectFlowing) console.error(await pcDebug(p));
        throw err;
      }
      console.log(`(retry ${attempt}/${MAX_CONNECT_ATTEMPTS - 1}) mesh not fully flowing — rejoin for a fresh RTCPeerConnection`);
      await page.getByRole("button", { name: "Burn & Leave" }).click();
      await page.waitForURL((u) => new URL(u).pathname === "/");
      await enterGreenRoomAndProceed(page, url);
      await page.getByRole("button", { name: "Burn & Leave" }).waitFor();
    }
  }
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
      // Startup requires these since Phase 3B (accounts tier); this scenario
      // never touches accounts/Studio — dummies keep the run hermetic.
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
    body: JSON.stringify({ label: "phase5a-e2e" }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

// ---------------------------------------------------------------------
// __cosCall.pod polling (app/room/page.tsx's debug mirror; `pod` is
// podcast.panel.kind).
// ---------------------------------------------------------------------
function waitPod(page, value, timeoutMs) {
  return page.waitForFunction((v) => window.__cosCall && window.__cosCall.pod === v, value, { timeout: timeoutMs });
}

/** window.__cosCall.podBytes — this side's recorder byte counts, video and
 *  audio counted SEPARATELY (hooks/usePodcastTake.ts's `bytes`, mirrored by
 *  app/room/page.tsx). Used instead of an aggregate total because an
 *  aggregate can't distinguish "both streams growing" from "one stream
 *  stalled while the other grows". */
async function podBytes(page) {
  return page.evaluate(() => window.__cosCall && window.__cosCall.podBytes);
}

// ---------------------------------------------------------------------
// OPFS introspection — each host's Vault lives at
// navigator.storage.getDirectory()/cos-vault/<takeId>/...
// ---------------------------------------------------------------------

/** This origin's OPFS quota usage — see header deviation note 3: this is
 *  what actually grows in real time while a part is still open (a
 *  FileSystemWritableFileStream is atomic-on-close, so the part's own
 *  exposed `.size` reads 0 until PART_TARGET_MS rollover or take-end). */
async function opfsUsage(page) {
  return page.evaluate(async () => (await navigator.storage.estimate()).usage);
}

async function opfsTakeDirName(page) {
  const names = await page.evaluate(async (vaultDirName) => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle(vaultDirName);
    const out = [];
    for await (const [name] of vault.entries()) out.push(name);
    return out;
  }, VAULT_DIR_NAME);
  return names.find((n) => n.startsWith("take-")) ?? null;
}

async function opfsFileSize(page, takeDir, fileName) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, fileName }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      try {
        const fh = await dir.getFileHandle(fileName);
        const file = await fh.getFile();
        return file.size;
      } catch {
        return null;
      }
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, fileName },
  );
}

async function opfsReadJSON(page, takeDir, fileName) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, fileName }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      const fh = await dir.getFileHandle(fileName);
      const file = await fh.getFile();
      return JSON.parse(await file.text());
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, fileName },
  ).catch(() => null);
}

/** Concatenate every part listed in a sidecar (in order) and return the total
 *  byte length plus the first 4 bytes of the reconstructed stream. */
async function opfsConcatFirstBytes(page, takeDir, base) {
  return page.evaluate(
    async ({ vaultDirName, takeDir, base }) => {
      const root = await navigator.storage.getDirectory();
      const vault = await root.getDirectoryHandle(vaultDirName);
      const dir = await vault.getDirectoryHandle(takeDir);
      const sidecarFh = await dir.getFileHandle(`${base}.sidecar.json`);
      const sidecar = JSON.parse(await (await sidecarFh.getFile()).text());
      let total = 0;
      let firstBytes = null;
      for (const part of sidecar.parts) {
        const fh = await dir.getFileHandle(part.name);
        const file = await fh.getFile();
        total += file.size;
        if (firstBytes === null) {
          firstBytes = Array.from(new Uint8Array(await file.slice(0, 4).arrayBuffer()));
        }
      }
      return { total, firstBytes, sidecarTotal: sidecar.parts.reduce((a, p) => a + p.size, 0), partCount: sidecar.parts.length };
    },
    { vaultDirName: VAULT_DIR_NAME, takeDir, base },
  );
}

async function stopSelfVideoTrack(page) {
  await page.evaluate(() => {
    const fig = [...document.querySelectorAll("figure")].find(
      (f) => f.querySelector("figcaption")?.textContent === "You",
    );
    if (!fig) throw new Error("self tile (figcaption 'You') not found");
    const video = fig.querySelector("video");
    const track = video?.srcObject?.getVideoTracks?.()[0];
    if (!track) throw new Error("self video track not found");
    track.stop();
  });
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-phase5a-e2e-"));
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

    const mainKeys = mkRoomKeys();
    const mainUrl = inviteUrl(mainKeys);

    const { context: ctxA, page: pageA } = await newHostPage(browser, CODENAME_A);
    const { context: ctxB, page: pageB } = await newHostPage(browser, CODENAME_B);

    // A holds the creation token (localStorage is per-origin — set it on :3000 first).
    await pageA.goto(`${BASE}/`);
    await pageA.evaluate((t) => localStorage.setItem("cos-create-token", t), token);

    // ---- Setup: A creates the room, B joins, mesh flows both ways ----
    await enterGreenRoomAndProceed(pageA, mainUrl);
    await pageA.getByRole("button", { name: "Burn & Leave" }).waitFor();
    await joinUntilFlowing(pageB, mainUrl, [[pageA, 1], [pageB, 1]]);
    await pageA.getByText("Agents present: 2").waitFor();
    await pageB.getByText("Agents present: 2").waitFor();
    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    await pageB.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);

    // Hello handshake settles the codename each side shows for the other —
    // needed so Check 5's banner-naming assertion is meaningful rather than
    // racing the fallback "Agent 2"/"PARTNER" label.
    await figcaption(pageA, CODENAME_B).waitFor({ timeout: 10000 });
    await figcaption(pageB, CODENAME_A).waitFor({ timeout: 10000 });

    // ---- Setup: arm the Tape Vault on both (stubbed picker) ----
    await pageA.getByRole("button", { name: "Choose Tape Vault" }).click();
    await pageB.getByRole("button", { name: "Choose Tape Vault" }).click();

    // ---- Check 1: both panels show Roll Tape (feature-detect + vault granted) ----
    await waitPod(pageA, "armed", 15000);
    await waitPod(pageB, "armed", 15000);
    const rollA = await pageA.getByRole("button", { name: "Roll Tape" }).isVisible();
    const rollB = await pageB.getByRole("button", { name: "Roll Tape" }).isVisible();
    check(rollA && rollB, "A & B: panel shows Roll Tape (armed) on both — feature-detect passed in Chromium");

    // ---- Check 2: a third context forces "Two Chairs Only"; leaving restores Roll Tape ----
    const { context: ctxC, page: pageC } = await newGuestPage(browser);
    await joinUntilFlowing(pageC, mainUrl, [[pageA, 2], [pageB, 2], [pageC, 2]]);
    await waitPod(pageA, "not-two", 5000);
    await waitPod(pageB, "not-two", 5000);
    const twoChairsA = await pageA.getByText("Two Chairs Only").isVisible();
    const twoChairsB = await pageB.getByText("Two Chairs Only").isVisible();
    check(twoChairsA && twoChairsB, "third context joins — both panels show the Two Chairs Only copy");

    await pageC.getByRole("button", { name: "Burn & Leave" }).click();
    await pageC.waitForURL((u) => new URL(u).pathname === "/");
    await ctxC.close();
    await waitPod(pageA, "armed", 10000);
    await waitPod(pageB, "armed", 10000);
    check(true, "third leaves — Roll Tape returns on both");

    // ---- Check 3: A rolls — both reach countdown, then rolling, within 6s ----
    const t3 = Date.now();
    await pageA.getByRole("button", { name: "Roll Tape" }).click();
    await Promise.all([waitPod(pageA, "countdown", 3000), waitPod(pageB, "countdown", 3000)]);
    await Promise.all([waitPod(pageA, "rolling", 5000), waitPod(pageB, "rolling", 5000)]);
    const elapsed3 = Date.now() - t3;
    check(elapsed3 <= 6000, `both reach countdown then rolling within 6s of Roll Tape (${elapsed3}ms)`);

    // ---- Check 4: OPFS introspection — A's part000 files exist; BOTH streams growing on BOTH contexts ----
    // (see header deviation note 3 for why disk-truth is measured via
    // navigator.storage.estimate() rather than a per-file .size read)
    const u1 = await opfsUsage(pageA);
    const bytesA1 = await podBytes(pageA);
    const bytesB1 = await podBytes(pageB);
    await new Promise((r) => setTimeout(r, 3000));
    const takeDirA = await opfsTakeDirName(pageA);
    const videoExists = (await opfsFileSize(pageA, takeDirA, "video.part000")) !== null;
    const audioExists = (await opfsFileSize(pageA, takeDirA, "audio.part000")) !== null;
    const u2 = await opfsUsage(pageA);
    const bytesA2 = await podBytes(pageA);
    const bytesB2 = await podBytes(pageB);
    check(
      !!takeDirA && videoExists && audioExists,
      `A's take dir "${takeDirA}": video.part000 and audio.part000 both exist`,
    );
    // Disk-truth signal (aggregate — kept alongside the per-stream check
    // below, not a replacement for it: an aggregate total can't tell "both
    // streams growing" apart from "one stream stalled while the other grows").
    check(u2 > u1, `A's OPFS storage usage growing while the take rolls: ${u1} -> ${u2} bytes`);
    check(
      bytesA2.video > bytesA1.video && bytesA2.audio > bytesA1.audio,
      `A: __cosCall.podBytes — BOTH streams strictly increasing (video ${bytesA1.video}->${bytesA2.video}, audio ${bytesA1.audio}->${bytesA2.audio})`,
    );
    check(
      bytesB2.video > bytesB1.video && bytesB2.audio > bytesB1.audio,
      `B: __cosCall.podBytes — BOTH streams strictly increasing (video ${bytesB1.video}->${bytesB2.video}, audio ${bytesB1.audio}->${bytesB2.audio})`,
    );

    // ---- Check 5: A's video track dies — both alarm within 3.5s; recorder survives ----
    const t5 = Date.now();
    await stopSelfVideoTrack(pageA);
    await Promise.all([waitPod(pageA, "fault", 3500), waitPod(pageB, "fault", 3500)]);
    const elapsed5 = Date.now() - t5;
    check(elapsed5 <= 3500, `both reach fault within 3.5s of the camera kill (${elapsed5}ms)`);

    // Scoped past Next's own route-announcer div, which also carries
    // role="alert" and would otherwise make this locator ambiguous.
    const aBannerText = (await pageA.locator('[role="alert"]', { hasText: "Tape Fault" }).innerText()).trim();
    const bBannerText = (await pageB.locator('[role="alert"]', { hasText: "Tape Fault" }).innerText()).trim();
    check(
      aBannerText.includes("YOUR") && aBannerText.includes("CAMERA DROPPED"),
      `A's own banner names its cause: YOUR CAMERA DROPPED (got: "${aBannerText}")`,
    );
    // Spec §5A: the banner names whose side AND what failed. The partner's own
    // cause rides their beacon and is threaded through evaluate() as the
    // remote fault's `detail` (lib/podcast/watchdog.ts), so B's banner reads
    // "<A's codename>: CAMERA DROPPED" — not the generic "REPORTS A FAULT".
    check(
      bBannerText.includes(CODENAME_A) && bBannerText.includes("CAMERA DROPPED"),
      `B's banner names A's codename + A's REAL cause, CAMERA DROPPED (got: "${bBannerText}")`,
    );
    check(
      !bBannerText.includes("REPORTS A FAULT"),
      `B's banner does NOT fall back to the generic "REPORTS A FAULT" (got: "${bBannerText}")`,
    );

    const postFault1 = await opfsUsage(pageA);
    await new Promise((r) => setTimeout(r, 2000));
    const postFault2 = await opfsUsage(pageA);
    check(
      postFault2 > postFault1,
      `A's recorder is still rolling after the camera kill: OPFS usage growing ${postFault1}->${postFault2} bytes`,
    );

    // ---- Check 6: dismiss + cut -> stopping -> armed; sidecars verify on both sides ----
    // Deviation 2 (see header note): B's own fault banner never self-clears
    // (A's beacon keeps carrying camera-lost forever), so B has no Cut button
    // until B ALSO stands down. Adapted: both stand down, then B cuts.
    await pageA.getByRole("button", { name: "Acknowledge" }).click();
    await waitPod(pageA, "rolling", 3000);
    await pageB.getByRole("button", { name: "Acknowledge" }).click();
    await waitPod(pageB, "rolling", 3000);
    check(true, "A stands down (back to rolling), B stands down (back to rolling)");

    await pageB.getByRole("button", { name: "Cut" }).click();
    await Promise.all([waitPod(pageA, "stopping", 3000), waitPod(pageB, "stopping", 3000)]);
    await Promise.all([waitPod(pageA, "armed", 6000), waitPod(pageB, "armed", 6000)]);
    check(true, "B cuts — both reach stopping, then armed");

    const takeDirB = await opfsTakeDirName(pageB);
    let sidecarsOk = true;
    for (const [label, page, dir] of [
      ["A", pageA, takeDirA],
      ["B", pageB, takeDirB],
    ]) {
      for (const base of ["video", "audio"]) {
        const sidecar = await opfsReadJSON(page, dir, `${base}.sidecar.json`);
        const hasParts = !!sidecar && Array.isArray(sidecar.parts) && sidecar.parts.length > 0;
        if (!hasParts) sidecarsOk = false;
        check(hasParts, `${label}: ${base}.sidecar.json exists with parts listed`);
        if (!hasParts) continue;
        for (const part of sidecar.parts) {
          const size = await opfsFileSize(page, dir, part.name);
          const ok = size === part.size;
          if (!ok) sidecarsOk = false;
          check(ok, `${label}: ${part.name} exists with the sidecar-listed size ${part.size} (got ${size})`);
        }
      }
    }
    check(sidecarsOk, "every sidecar-listed part exists with the listed size, both sides");

    // ---- Check 7: byte-concat A's audio parts -> total matches sidecar sum, EBML magic intact ----
    const concat = await opfsConcatFirstBytes(pageA, takeDirA, "audio");
    check(
      concat.total === concat.sidecarTotal,
      `A: concatenated audio parts total ${concat.total} bytes equals sidecar sum ${concat.sidecarTotal} bytes (${concat.partCount} part(s))`,
    );
    const magicOk =
      Array.isArray(concat.firstBytes) &&
      concat.firstBytes.length === 4 &&
      concat.firstBytes[0] === 0x1a &&
      concat.firstBytes[1] === 0x45 &&
      concat.firstBytes[2] === 0xdf &&
      concat.firstBytes[3] === 0xa3;
    check(
      magicOk,
      `A: reconstructed audio stream starts with the EBML magic 1A 45 DF A3 (got ${(concat.firstBytes || []).map((b) => b.toString(16).padStart(2, "0")).join(" ")})`,
    );

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
