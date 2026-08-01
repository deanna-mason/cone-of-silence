#!/usr/bin/env node
// Darkroom CLI + vault watcher (D12). Flags: --vault <dir> (required),
// --own-codename <name> (default HOST), --model <path> (default
// server/models/std.rnnn), --develop <manifestPath> (one-shot), --poll-ms
// <n> (default 5000). No config file.
//
// --develop runs developEpisode once and exits 0 / non-zero with
// `darkroom: <code>: <detail>` on stderr. Otherwise this watches the vault:
// every poll it scans for takes and develops (one at a time, sequentially)
// any whose episodes/<id>/episode.mp4 is absent (D11's developed marker). A
// refusal is logged loudly and does NOT halt the watcher — sources are
// untouched, so it simply re-logs (and retries) next poll. SIGINT exits
// cleanly, without waiting out the remainder of a poll interval.
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
 *  (D11): episodes/<episodeId>/episode.mp4. */
export function developedMp4Path(vaultDir, episodeId) {
  return path.join(vaultDir, "episodes", episodeId, "episode.mp4");
}

export async function isDeveloped(vaultDir, episodeId) {
  try {
    await fsp.access(developedMp4Path(vaultDir, episodeId));
    return true;
  } catch {
    return false;
  }
}

/**
 * One watcher pass: scans the vault, develops (sequentially, one at a time)
 * every take lacking its developed marker. `developEpisodeFn` is injected
 * (the real `developEpisode`, or a fake in tests) and is called as
 * `developEpisodeFn(pipelineDeps, manifestPath, pipelineOpts)` — matching
 * developEpisode's own contract. A refusal is logged via `log.error` and
 * does not stop the pass; sources are left untouched, so the take is simply
 * retried on the next call. Returns a per-take status array (developed /
 * skipped / refused) for observability and testing.
 */
export async function pollOnce(
  developEpisodeFn,
  pipelineDeps,
  vaultDir,
  pipelineOpts,
  log = { error: (...args) => console.error(...args) },
) {
  const takes = await scanVault(vaultDir);
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
      await developEpisodeFn(pipelineDeps, take.manifestPath, pipelineOpts);
      results.push({ takeId: take.takeId, status: "developed" });
    } catch (err) {
      const code = err instanceof DarkroomError ? err.code : "unknown";
      const detail = err instanceof DarkroomError ? err.message : String((err && err.message) || err);
      log.error(`darkroom: ${code}: ${detail} (take ${take.takeId} — sources untouched, will retry next poll)`);
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
  const { sleep, interrupt } = makeInterruptibleSleep();
  const stop = () => {
    stopped = true;
    interrupt();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    // eslint-disable-next-line no-await-in-loop -- polling loop, by design
    await pollOnce(developEpisode, pipelineDeps, opts.vault, pipelineOpts, console);
    if (stopped) break;
    // eslint-disable-next-line no-await-in-loop -- polling loop, by design
    await sleep(opts.pollMs);
  }
  process.exitCode = 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
