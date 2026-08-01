#!/usr/bin/env node
// Darkroom CLI + vault watcher (D12). Flags: --vault <dir> (required),
// --own-codename <name> (default HOST), --model <path> (default
// server/models/std.rnnn), --develop <manifestPath> (one-shot), --poll-ms
// <n> (default 5000). No config file.
//
// --develop runs developEpisode once and exits 0 / non-zero with
// `darkroom: <code>: <detail>` on stderr. Otherwise this watches the vault:
// every poll it scans for takes and develops (one at a time, sequentially)
// any whose episodes/<id>/develop.json is absent (D22's developed marker —
// moved off episode.mp4, since an audio-only episode never produces one). A
// refusal is logged loudly and does NOT halt the watcher — sources are
// untouched, so it simply re-logs (and retries) next poll. A scanVault
// failure (vault momentarily gone, EACCES, a bad --vault) is likewise
// logged and does not crash the daemon (CRITICAL 1, Task 6 review). First
// SIGINT/SIGTERM finishes the take in flight, then exits; a second signal
// exits immediately (IMPORTANT 6).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DarkroomError } from "./errors.mjs";
import { scanVault } from "./vault.mjs";
import { developEpisode, DEFAULT_OWN_CODENAME, DEFAULT_MODEL } from "./pipeline.mjs";
import { makeRunner } from "./runner.mjs";
import { decodePcm } from "./decode.mjs";
import { renderBackdrop } from "./composite.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLL_MS = 5000;

/** Parses argv (already stripped of `node script.mjs`) into CLI options.
 *  Throws DarkroomError("cli-invalid", ...) on an unknown flag, a flag
 *  missing its value, or a missing required --vault. */
export function parseArgs(argv) {
  const opts = {
    vault: null,
    ownCodename: DEFAULT_OWN_CODENAME,
    model: DEFAULT_MODEL,
    develop: null,
    pollMs: DEFAULT_POLL_MS,
  };

  const need = (i, flag) => {
    if (i >= argv.length) throw new DarkroomError("cli-invalid", `${flag} requires a value`);
    return argv[i];
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--vault":
        opts.vault = need(++i, flag);
        break;
      case "--own-codename":
        opts.ownCodename = need(++i, flag);
        break;
      case "--model":
        opts.model = need(++i, flag);
        break;
      case "--develop":
        opts.develop = need(++i, flag);
        break;
      case "--poll-ms": {
        const raw = need(++i, flag);
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new DarkroomError("cli-invalid", `--poll-ms must be a positive number, got "${raw}"`);
        }
        opts.pollMs = n;
        break;
      }
      default:
        throw new DarkroomError("cli-invalid", `unknown flag "${flag}"`);
    }
  }

  if (!opts.vault) {
    throw new DarkroomError("cli-invalid", "--vault is required");
  }
  return opts;
}

/** The path the watcher (and --develop) treats as the "developed" marker
 *  (D22, superseding D11's episode.mp4 — an audio-only episode never
 *  produces one): episodes/<episodeId>/develop.json. */
export function developedMarkerPath(vaultDir, episodeId) {
  return path.join(vaultDir, "episodes", episodeId, "develop.json");
}

export async function isDeveloped(vaultDir, episodeId) {
  try {
    await fsp.access(developedMarkerPath(vaultDir, episodeId));
    return true;
  } catch {
    return false;
  }
}

/**
 * One watcher pass: scans the vault, develops (sequentially, one at a time)
 * every take lacking its developed marker.
 *
 * `fns.developEpisode` is called as `fns.developEpisode(pipelineDeps,
 * manifestPath, pipelineOpts)` — matching developEpisode's own contract.
 * `fns.scanVault` is called as `fns.scanVault(vaultDir)`. Both are injected
 * (the real functions, or fakes in tests).
 *
 * A per-take refusal is logged via `log.error` and does not stop the pass;
 * sources are left untouched, so the take is simply retried on the next
 * call. A `scanVault` failure itself (vault momentarily gone, EACCES, a bad
 * --vault) is likewise logged and swallowed rather than thrown — the whole
 * point of a watcher is that a transient vault hiccup doesn't kill the
 * daemon (CRITICAL 1, Task 6 review); the caller's poll loop is expected to
 * try again next interval regardless of what this returns.
 *
 * Returns a per-take status array (developed / skipped / refused) for
 * observability and testing; an empty array on a scanVault failure (nothing
 * was scanned, so nothing to report per-take).
 */
export async function pollOnce(
  fns,
  pipelineDeps,
  vaultDir,
  pipelineOpts,
  log = { error: (...args) => console.error(...args) },
) {
  let takes;
  try {
    takes = await fns.scanVault(vaultDir);
  } catch (err) {
    log.error(`darkroom: scan-failed: ${(err && err.message) || String(err)} (vault ${vaultDir} — will retry next poll)`);
    return [];
  }

  const results = [];
  for (const take of takes) {
    // eslint-disable-next-line no-await-in-loop -- one at a time, sequential (spec)
    const already = await isDeveloped(vaultDir, take.takeId);
    if (already) {
      results.push({ takeId: take.takeId, status: "skipped" });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- one at a time, sequential (spec)
      await fns.developEpisode(pipelineDeps, take.manifestPath, pipelineOpts);
      results.push({ takeId: take.takeId, status: "developed" });
    } catch (err) {
      // IMPORTANT 5 (Task 6 review): a DarkroomError's own .message is
      // already "<code>: <detail>" — prefixing it with the code AGAIN
      // printed it twice ("darkroom: part-gap: part-gap: ..."). Use the
      // message as-is.
      const code = err instanceof DarkroomError ? err.code : "unknown";
      const message = err instanceof DarkroomError ? err.message : `unknown: ${(err && err.message) || String(err)}`;
      log.error(`darkroom: ${message} (take ${take.takeId} — sources untouched, will retry next poll)`);
      results.push({ takeId: take.takeId, status: "refused", code });
    }
  }
  return results;
}

/** playwright-core headless-Chrome executable resolution — the phase5a-e2e
 *  EXECUTABLE pattern (see e2e/phase5a-e2e.js), ported verbatim: pick the
 *  HIGHEST cached revision under the transient `--no-save` install cache,
 *  since a stale older build beside a newer one is incompatible with the
 *  installed playwright-core. Real wiring only — never used by pipeline.mjs
 *  itself, which receives renderBackdrop already bound to a resolved path. */
function resolveChromePath() {
  const SHELL_ROOT = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const shellDir = fs
    .readdirSync(SHELL_ROOT)
    .filter((d) => d.startsWith("chromium_headless_shell"))
    .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))[0];
  if (!shellDir) {
    throw new DarkroomError("template-render-failed", `no chromium_headless_shell build found under ${SHELL_ROOT}`);
  }
  return path.join(SHELL_ROOT, shellDir, "chrome-headless-shell-mac-x64/chrome-headless-shell");
}

function buildPipelineDeps() {
  return {
    runner: makeRunner("ffmpeg"),
    renderBackdrop,
    decodePcm,
    now: () => new Date().toISOString(),
  };
}

function buildPipelineOpts(opts) {
  return {
    ownCodename: opts.ownCodename,
    model: opts.model,
    chromePath: resolveChromePath(),
    templatePath: path.join(SCRIPT_DIR, "template.html"),
  };
}

function printErrorAndExit(err) {
  if (err instanceof DarkroomError) {
    process.stderr.write(`darkroom: ${err.message}\n`);
  } else {
    process.stderr.write(`darkroom: unknown: ${(err && err.message) || String(err)}\n`);
  }
  process.exitCode = 1;
}

/** A sleep that a SIGINT handler can resolve early, so the watcher exits
 *  immediately instead of waiting out the rest of the current poll
 *  interval. */
function makeInterruptibleSleep() {
  let resolveFn = null;
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        resolveFn = resolve;
        setTimeout(resolve, ms);
      });
    },
    interrupt() {
      if (resolveFn) resolveFn();
    },
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    printErrorAndExit(err);
    return;
  }

  const pipelineDeps = buildPipelineDeps();
  let pipelineOpts;
  try {
    pipelineOpts = buildPipelineOpts(opts);
  } catch (err) {
    printErrorAndExit(err);
    return;
  }

  if (opts.develop) {
    try {
      await developEpisode(pipelineDeps, opts.develop, pipelineOpts);
      process.exitCode = 0;
    } catch (err) {
      printErrorAndExit(err);
    }
    return;
  }

  let stopped = false;
  let signalCount = 0;
  const { sleep, interrupt } = makeInterruptibleSleep();
  const stop = () => {
    signalCount += 1;
    // IMPORTANT 6 (Task 6 review): first signal finishes the take currently
    // in flight (if any) then exits at the top of the loop, same as before.
    // A second signal means the operator already asked once and is done
    // waiting — exit immediately rather than finish whatever's running.
    if (signalCount >= 2) {
      process.exit(130); // 128 + SIGINT(2), the conventional signal exit code
      return;
    }
    stopped = true;
    interrupt();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    // eslint-disable-next-line no-await-in-loop -- polling loop, by design
    await pollOnce({ developEpisode, scanVault }, pipelineDeps, opts.vault, pipelineOpts, console);
    if (stopped) break;
    // eslint-disable-next-line no-await-in-loop -- polling loop, by design
    await sleep(opts.pollMs);
  }
  process.exitCode = 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // CRITICAL 1 (Task 6 review): anything that escapes main() unhandled
  // (a bad --vault, EACCES, or any other bug this round's fixes missed)
  // used to crash the daemon with a raw Node stack trace. Print it in the
  // standard `darkroom: <code>: <detail>` shape and exit non-zero instead.
  main().catch((err) => {
    printErrorAndExit(err);
    process.exit(1);
  });
}
