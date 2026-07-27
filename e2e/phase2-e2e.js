// e2e/phase2-e2e.js
// Phase 4B regression: a four-browser mesh call over the ws signaling server
// (grown from the Phase 2 two-browser script). Owns the signaling server's
// lifecycle itself (spawns it on :8787 with a throwaway file store +
// test-only admin secret).
// This is the consumer of the window.__cosCall debug mirror in app/room/page.tsx.
//
// Run (macOS): `npm i --no-save playwright-core` once, have `next dev` on :3000
// and NOTHING on :8787, then `node e2e/phase2-e2e.js`. Reads the newest
// chromium_headless_shell from the local Playwright cache. (A same-tick
// two-new-RTCPeerConnection ICE-gathering wedge was diagnosed on this
// machine across chrome-headless-shell, a full Chromium 1223 build, AND
// the system-installed Google Chrome — all three executables reproduce it,
// pointing at a machine-level cause rather than this specific binary. See
// .superpowers/sdd/task-5-report.md for the full diagnostic trail.)
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const BASE = "http://localhost:3000";
const PORT = 8787;
const ADMIN_SECRET = "phase2-e2e-secret-0123456789";
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");

const SHELL_ROOT = path.join(os.homedir(), "Library/Caches/ms-playwright");
// Pick the HIGHEST cached revision — a stale older build (e.g. 1217 beside
// 1223) is incompatible with the installed playwright-core and fails with
// silent click() timeouts.
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

async function newPage(browser) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  // Test-only instrumentation (never touches product source): stash every
  // RTCPeerConnection instance on window so a failure can print its final
  // ICE/connection state for diagnosis.
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

// Remote tiles are labeled "Agent 2".."Agent 4" (positional). A page is
// "fully flowing" when it shows exactly `count` such tiles, all with live
// video frames.
async function waitRemoteVideosFlowing(page, count, timeoutMs) {
  await page.waitForFunction(
    (expected) => {
      const figs = [...document.querySelectorAll("figure")].filter((f) =>
        /^Agent \d$/.test(f.querySelector("figcaption")?.textContent || ""),
      );
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

// Known headless-Chromium flake (diagnosed during Phase 2 script
// development, not an app bug): after a perfect-negotiation rollback,
// Chromium's ICE agent on the rolled-back side sometimes never fires a
// single local icecandidate, so that one pair never connects. A fresh
// RTCPeerConnection clears it — so the NEWCOMER (whose pairs are the only
// unproven ones) leaves & rejoins, bounded retries. Mesh growth multiplies
// the exposure: every join creates N new pairs, any one can wedge.
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
      console.log(
        `(retry ${attempt}/${MAX_CONNECT_ATTEMPTS - 1}) mesh not fully flowing — newcomer leaves & rejoins for a fresh RTCPeerConnection`,
      );
      await page.getByRole("button", { name: "Burn & Leave" }).click();
      await page.waitForURL((u) => new URL(u).pathname === "/");
      await enterGreenRoomAndProceed(page, url);
      await page.getByRole("button", { name: "Burn & Leave" }).waitFor();
    }
  }
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
      // Startup requires these since Phase 3B (accounts tier), but no phase-2
      // scenario touches accounts/Studio — dummies keep this run hermetic.
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
    body: JSON.stringify({ label: "phase2-e2e" }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  return token;
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-phase2-e2e-"));
  const tokenFile = path.join(tmpDir, "tokens.json");
  let server = null;
  let browser = null;

  try {
    server = await spawnServer(tokenFile);
    const token = await mintToken();

    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
        // WebRtcHideLocalIpsWithMdns: Chrome normally masks host ICE
        // candidates behind mDNS hostnames, which needs multicast DNS
        // resolution — unavailable in this headless/sandboxed environment,
        // so two same-machine peer connections never find a usable
        // candidate pair. Disabling it exposes the real loopback IP so
        // localhost-to-localhost P2P actually connects.
        "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox,WebRtcHideLocalIpsWithMdns",
      ],
    });

    const mainKeys = mkRoomKeys();
    const otherKeys = mkRoomKeys();
    const mainUrl = inviteUrl(mainKeys);

    const { context: ctxA, page: pageA } = await newPage(browser);
    const { context: ctxB, page: pageB } = await newPage(browser);
    const { context: ctxC, page: pageC } = await newPage(browser);
    const { context: ctxD, page: pageD } = await newPage(browser);
    const { context: ctxE, page: pageE } = await newPage(browser);
    const { context: ctxF, page: pageF } = await newPage(browser);

    // A holds the creation token (localStorage is per-origin — set it on :3000 first).
    await pageA.goto(`${BASE}/`);
    await pageA.evaluate((t) => localStorage.setItem("cos-create-token", t), token);

    // ---- Check 1: A creates the room (join-miss → create) ----
    await enterGreenRoomAndProceed(pageA, mainUrl);
    await pageA.getByRole("button", { name: "Burn & Leave" }).waitFor();
    const agents1 = await pageA.getByText("Agents present: 1").isVisible();
    const awaiting1 = await figcaption(pageA, "Awaiting agent").isVisible();
    check(agents1 && awaiting1, "A: room created — Agents present: 1, remote tile Awaiting agent");

    // ---- Check 2: A's status becomes waiting ----
    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.status === "waiting");
    check(true, "A: window.__cosCall.status === 'waiting'");

    // ---- Check 3: B joins — both see 2 agents, remote tile Agent 2, video flowing ----
    await joinUntilFlowing(pageB, mainUrl, [[pageA, 1], [pageB, 1]]);
    await pageA.getByText("Agents present: 2").waitFor();
    await pageB.getByText("Agents present: 2").waitFor();
    const agent2A = await figcaption(pageA, "Agent 2").isVisible();
    const agent2B = await figcaption(pageB, "Agent 2").isVisible();
    check(agent2A && agent2B, "A & B: Agents present: 2, remote tile Agent 2, video flowing both ways");

    // ---- Check 4: data channel open on both ----
    await pageA.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    await pageB.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    check(true, "A & B: window.__cosCall.dcOpen === true on both");

    // ---- Check 5: C joins — 3-way mesh, everyone sees everyone ----
    await joinUntilFlowing(pageC, mainUrl, [[pageA, 2], [pageB, 2], [pageC, 2]]);
    for (const p of [pageA, pageB, pageC]) await p.getByText("Agents present: 3").waitFor();
    check(true, "A, B, C: 3-way mesh — 2 remote videos flowing on every page");

    // ---- Check 6: D joins — full 2x2 mesh ----
    await joinUntilFlowing(pageD, mainUrl, [[pageA, 3], [pageB, 3], [pageC, 3], [pageD, 3]]);
    for (const p of [pageA, pageB, pageC, pageD]) await p.getByText("Agents present: 4").waitFor();
    await pageD.waitForFunction(() => window.__cosCall && window.__cosCall.dcOpen === true);
    check(true, "A-D: 4-way mesh — 3 remote videos flowing on every page, D dcOpen");

    // ---- Check 7: no-scroll rule at phone viewport (390x844) ----
    await pageD.setViewportSize({ width: 390, height: 844 });
    const fits = await pageD.evaluate(() => {
      const vh = window.innerHeight;
      const rects = [
        ...[...document.querySelectorAll("figure")].map((f) => f.getBoundingClientRect()),
        ...[...document.querySelectorAll("button")]
          .filter((b) => (b.textContent || "").includes("Burn & Leave"))
          .map((b) => b.getBoundingClientRect()),
      ];
      return (
        rects.length === 5 && // 4 tiles + the leave button
        rects.every((r) => r.top >= 0 && r.bottom <= vh + 1 && r.height > 40)
      );
    });
    check(fits, "D at 390x844: all four tiles + controls fully inside the visible viewport (no scroll)");
    await pageD.setViewportSize({ width: 1280, height: 720 });

    // ---- Check 8: a fifth agent is refused ----
    await enterGreenRoomAndProceed(pageE, mainUrl);
    await pageE.getByText("The Cone Seats Four").waitFor();
    check(true, "E: refused entry — 'The Cone Seats Four'");

    // ---- Check 9: creator-first leave strands nobody ----
    await pageA.getByRole("button", { name: "Burn & Leave" }).click();
    await pageA.waitForURL((u) => new URL(u).pathname === "/");
    for (const p of [pageB, pageC, pageD]) {
      await p.getByText("Agents present: 3").waitFor();
      await waitRemoteVideosFlowing(p, 2, 20000);
    }
    check(true, "creator A leaves — B, C, D drop to 3 agents, mesh still flowing");

    // ---- Check 10: A rejoins (newcomer polite toward three incumbents) ----
    await joinUntilFlowing(pageA, mainUrl, [[pageA, 3], [pageB, 3], [pageC, 3], [pageD, 3]]);
    for (const p of [pageA, pageB, pageC, pageD]) await p.getByText("Agents present: 4").waitFor();
    check(true, "A rejoins via the same invite — full 4-way mesh restored");

    // ---- Check 11: mid-roster leave ----
    await pageB.getByRole("button", { name: "Burn & Leave" }).click();
    await pageB.waitForURL((u) => new URL(u).pathname === "/");
    for (const p of [pageA, pageC, pageD]) await p.getByText("Agents present: 3").waitFor();
    check(true, "B leaves — remaining three agents intact");

    // ---- Check 12: a fresh context on a different, never-created invite ----
    await enterGreenRoomAndProceed(pageF, inviteUrl(otherKeys));
    await pageF.getByText("This Corridor Is Dark").waitFor();
    check(true, "F: different invite, no token — 'This Corridor Is Dark' (join never auto-creates)");

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
    await ctxD.close();
    await ctxE.close();
    await ctxF.close();
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
