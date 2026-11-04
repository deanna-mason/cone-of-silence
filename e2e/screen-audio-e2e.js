// e2e/screen-audio-e2e.js
// Screen-share AUDIO acceptance, headless, on real Chrome WebRTC + the
// shipped E2EE path. Three agents in a room (A creates; B and C join) — a
// NON-host (B) tables a screen that carries tab audio, and every other seat
// must receive it on the screen tile, unmuted, decrypted, and audibly
// flowing. Then: a fourth agent joining MID-share inherits it; per-tile Mute
// works; stopping ends the capture and the far tiles; a share WITHOUT audio
// (C) shows the sharer the "No audio shared" note and a silent, Mute-less
// tile remotely; and B's re-share (the parked-sender replaceTrack path)
// flows audio again.
//
// Harness-only stubs (no production file is touched): getDisplayMedia is
// replaced in-page by a canvas picture + a 440 Hz WebAudio oscillator (the
// headless shell has no real picker/tab capture), RTCPeerConnection is
// captured (window.__pcs) for getStats(), and createEncodedStreams is
// wiretapped (window.__pipes) to prove every screen-audio sender/receiver
// got an E2EE pipe. Idioms copied from e2e/phase5d-e2e.js.
//
// Run (macOS, node UNSANDBOXED like the other e2e gates): have `next dev`
// on E2E_PORT (default 3000; `npx next dev -p 3100` + E2E_PORT=3100 when
// 3000 is taken) and nothing on :8787, then `node e2e/screen-audio-e2e.js`.
// --allow-loopback-in-peer-connection: on a Mac whose firewall drops UDP to
// its own LAN address, ICE otherwise sits in "checking" forever; loopback
// host candidates let four same-machine contexts connect.
// Known flake (2026-11-04, NOT screen-share related — reproduced with the
// share steps removed): a 4th same-machine agent's link to the host can sit
// in connectionState "new" on both ends, timing out the "Agents present: 4"
// wait. Re-run; a pass is every check green.
const { chromium } = require("playwright-core");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

const WEB_PORT = Number(process.env.E2E_PORT || 3000);
const BASE = `http://localhost:${WEB_PORT}`;
const PORT = 8787;
const ADMIN_SECRET = "screen-audio-e2e-secret-0123456789";
const SERVER_DIR = path.join(__dirname, "..", "server");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function spawnServer(tokenFile) {
  if (await portInUse(PORT)) {
    console.error(`stop whatever holds :${PORT} first`);
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
      ALLOWED_ORIGINS: BASE,
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
      reject(new Error(`signaling server exited early (code ${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
  return child;
}

async function mintToken() {
  const res = await fetch(`http://localhost:${PORT}/admin/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}` },
    body: JSON.stringify({ label: "screen-audio-e2e" }),
  });
  if (!res.ok) throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

async function newAgent(browser) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  await context.addInitScript(() => {
    const RealPC = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = new Proxy(RealPC, {
      construct(target, args) {
        const pc = new target(...args);
        window.__pcs.push(pc);
        return pc;
      },
    });
    // E2EE wiretap: every encoded-streams pipe, with the track it carries.
    window.__pipes = [];
    for (const [Ctor, side] of [
      [window.RTCRtpSender, "encrypt"],
      [window.RTCRtpReceiver, "decrypt"],
    ]) {
      const real = Ctor && Ctor.prototype.createEncodedStreams;
      if (!real) continue;
      Ctor.prototype.createEncodedStreams = function () {
        window.__pipes.push({ side, kind: this.track && this.track.kind, trackId: this.track && this.track.id });
        return real.call(this);
      };
    }
    // The picker stand-in: canvas picture, plus a 440 Hz tone unless
    // __gdmNoAudio (the "didn't tick Share tab audio" case).
    window.__gdmNoAudio = false;
    navigator.mediaDevices.getDisplayMedia = async (opts) => {
      window.__gdmOpts = JSON.parse(JSON.stringify(opts));
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const g = canvas.getContext("2d");
      let n = 0;
      const paint = () => {
        g.fillStyle = `hsl(${(n++ * 7) % 360},80%,50%)`;
        g.fillRect(0, 0, 640, 360);
      };
      paint();
      setInterval(paint, 33);
      const tracks = [canvas.captureStream(30).getVideoTracks()[0]];
      if (!window.__gdmNoAudio) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        tracks.push(dest.stream.getAudioTracks()[0]);
      }
      window.__gdmStream = new MediaStream(tracks);
      return window.__gdmStream;
    };
  });
  return { context, page: await context.newPage() };
}

async function enterRoom(page, url) {
  await page.goto(url);
  await page.getByText("Check Your Cover").waitFor();
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.srcObject && v.srcObject.getVideoTracks().length > 0;
  });
  await page.getByRole("button", { name: "Enter the Cone" }).click();
  await page.getByRole("button", { name: "Burn & Leave" }).waitFor();
}

/** The one remote screen tile's state, read in-page: tracks, muted, picture,
 *  the screen-audio track's inbound-rtp counters, and whether that track's
 *  receiver got a decrypt pipe. null when no remote screen tile exists. */
function screenTileState(page) {
  return page.evaluate(async () => {
    const fig = [...document.querySelectorAll("figure")].find((f) => {
      const cap = f.querySelector("figcaption")?.textContent || "";
      return cap.endsWith("'s Screen");
    });
    if (!fig) return null;
    const video = fig.querySelector("video");
    const stream = video && video.srcObject;
    const audio = stream ? stream.getAudioTracks()[0] : undefined;
    let bytes = 0;
    let energy = 0;
    if (audio) {
      for (const pc of window.__pcs) {
        if (pc.connectionState === "closed") continue;
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === "inbound-rtp" && r.kind === "audio" && r.trackIdentifier === audio.id) {
            bytes = r.bytesReceived || 0;
            energy = r.totalAudioEnergy || 0;
          }
        });
      }
    }
    return {
      label: fig.querySelector("figcaption").textContent,
      audioTracks: stream ? stream.getAudioTracks().length : 0,
      muted: video.muted,
      videoWidth: video.videoWidth,
      bytes,
      energy,
      decryptPiped: !!audio && window.__pipes.some((p) => p.side === "decrypt" && p.trackId === audio.id),
      muteButton: !!fig.querySelector('button[aria-label^="Mute "]'),
    };
  });
}

async function waitScreenTile(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("figure")].some((f) => {
        const cap = f.querySelector("figcaption")?.textContent || "";
        const v = f.querySelector("video");
        return cap.endsWith("'s Screen") && v && v.videoWidth > 0;
      }),
    null,
    { timeout: timeoutMs },
  );
}

/** Audio is genuinely flowing AND decoding: bytes and decoded energy both
 *  rise across a 2s window. Encrypted frames that missed their decrypt
 *  transform would still add bytes but never decode to energy. */
async function audioFlowing(page) {
  const a = await screenTileState(page);
  await sleep(2000);
  const b = await screenTileState(page);
  return { ok: !!a && !!b && b.bytes > a.bytes && b.energy > a.energy, a, b };
}

async function noRemoteScreen(page, timeoutMs = 10000) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("figcaption")].some((c) => (c.textContent || "").endsWith("'s Screen")),
    null,
    { timeout: timeoutMs },
  );
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cos-screen-audio-e2e-"));
  let server = null;
  let browser = null;
  try {
    server = await spawnServer(path.join(tmpDir, "tokens.json"));
    const token = await mintToken();
    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--no-sandbox",
        "--allow-loopback-in-peer-connection",
        "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox,WebRtcHideLocalIpsWithMdns",
      ],
    });
    const keys = {
      roomId: crypto.randomBytes(16).toString("base64url"),
      secret: crypto.randomBytes(16).toString("base64url"),
    };
    const url = `${BASE}/room#r=${keys.roomId}&s=${keys.secret}`;

    const A = await newAgent(browser);
    const B = await newAgent(browser);
    const C = await newAgent(browser);
    await A.page.goto(`${BASE}/`);
    await A.page.evaluate((t) => localStorage.setItem("cos-create-token", t), token);
    await enterRoom(A.page, url);
    await enterRoom(B.page, url);
    await enterRoom(C.page, url);
    for (const p of [A.page, B.page, C.page]) await p.getByText("Agents present: 3").waitFor({ timeout: 30000 });
    check(true, "setup: A, B, C in one room");

    // ---- Check 1: B (a non-host) tables a screen WITH audio ----
    await B.page.getByRole("button", { name: "Table Your Screen" }).click();
    await B.page.getByRole("button", { name: "Screen on the Table" }).waitFor();
    const opts = await B.page.evaluate(() => window.__gdmOpts);
    check(
      opts && opts.systemAudio === "include" && opts.audio && opts.audio.restrictOwnAudio === true,
      `check 1: getDisplayMedia asked for audio (opts=${JSON.stringify(opts)})`,
    );
    for (const [name, agent] of [
      ["A", A],
      ["C", C],
    ]) {
      await waitScreenTile(agent.page);
      const flow = await audioFlowing(agent.page);
      const s = flow.b;
      check(s && s.audioTracks === 1, `check 1: ${name}'s screen tile carries B's screen audio track (${JSON.stringify(s)})`);
      check(s && s.muted === false, `check 1: ${name}'s screen tile plays it UNMUTED`);
      check(s && s.decryptPiped, `check 1: ${name}'s screen-audio receiver has an E2EE decrypt pipe`);
      check(flow.ok, `check 1: ${name} receives AND decodes screen audio (bytes ${flow.a?.bytes}→${s?.bytes}, energy ${flow.a?.energy}→${s?.energy})`);
      check(s && s.muteButton, `check 1: ${name}'s screen tile offers a Mute control`);
    }
    const sharer = await B.page.evaluate(() => {
      const audioId = window.__gdmStream.getAudioTracks()[0].id;
      const fig = [...document.querySelectorAll("figure")].find(
        (f) => f.querySelector("figcaption")?.textContent === "Your Screen",
      );
      return {
        previewMuted: fig.querySelector("video").muted,
        encryptPipes: window.__pipes.filter((p) => p.side === "encrypt" && p.trackId === audioId).length,
        note: document.body.textContent.includes("No audio shared"),
      };
    });
    check(sharer.previewMuted, "check 1: B's own screen preview stays muted (no playback echo)");
    check(sharer.encryptPipes === 2, `check 1: B's screen audio got an E2EE encrypt pipe on BOTH links (${sharer.encryptPipes})`);
    check(!sharer.note, "check 1: no 'No audio shared' note when audio was shared");

    // ---- Check 2: D joins MID-share and inherits the screen audio ----
    const D = await newAgent(browser);
    await enterRoom(D.page, url);
    await D.page.getByText("Agents present: 4").waitFor({ timeout: 30000 });
    await waitScreenTile(D.page, 30000);
    const flowD = await audioFlowing(D.page);
    check(
      flowD.ok && flowD.b.muted === false && flowD.b.decryptPiped,
      `check 2: D (joined mid-share) hears B's screen, decrypted (${JSON.stringify(flowD.b)})`,
    );

    // ---- Check 3: per-tile Mute on A ----
    const label = (await screenTileState(A.page)).label;
    await A.page.getByRole("button", { name: `Mute ${label}` }).click();
    check((await screenTileState(A.page)).muted === true, "check 3: Mute silences A's screen tile");
    await A.page.getByRole("button", { name: `Unmute ${label}` }).click();
    check((await screenTileState(A.page)).muted === false, "check 3: Unmute restores it");

    // ---- Check 4: B stops — capture ended, tiles gone everywhere ----
    await B.page.getByRole("button", { name: "Screen on the Table" }).click();
    await B.page.getByRole("button", { name: "Table Your Screen" }).waitFor();
    const ended = await B.page.evaluate(() => window.__gdmStream.getTracks().map((t) => t.readyState));
    check(ended.every((s) => s === "ended"), `check 4: B's capture tracks all ended, audio included (${ended})`);
    for (const [name, agent] of [
      ["A", A],
      ["C", C],
      ["D", D],
    ]) {
      await noRemoteScreen(agent.page);
      check(true, `check 4: ${name}'s screen tile is gone`);
    }

    // ---- Check 5: C shares WITHOUT audio ----
    await C.page.evaluate(() => (window.__gdmNoAudio = true));
    await C.page.getByRole("button", { name: "Table Your Screen" }).click();
    await C.page.getByText("No audio shared", { exact: false }).waitFor({ timeout: 10000 });
    check(true, "check 5: C (sharing silently) sees the 'No audio shared' note");
    await waitScreenTile(A.page);
    const silent = await screenTileState(A.page);
    check(
      silent.audioTracks === 0 && silent.muted === true && !silent.muteButton,
      `check 5: A's tile for C's silent share is muted with no Mute control (${JSON.stringify(silent)})`,
    );
    await C.page.getByRole("button", { name: "Screen on the Table" }).click();
    await noRemoteScreen(A.page);

    // ---- Check 6: B re-shares (parked senders re-armed) — audio flows again ----
    await B.page.getByRole("button", { name: "Table Your Screen" }).click();
    await waitScreenTile(A.page);
    const flowRe = await audioFlowing(A.page);
    check(flowRe.ok && flowRe.b.muted === false, `check 6: B's re-share is audible on A again (${JSON.stringify(flowRe.b)})`);
  } catch (err) {
    console.error(err);
    failures++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
