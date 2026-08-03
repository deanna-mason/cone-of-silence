// Injectable ffmpeg process runner — the `server/src/studio/runner.ts` idiom
// ported to plain Node ESM. Every downstream module takes the runner
// returned here as a PARAMETER (never imports this module directly), so
// unit tests substitute a fake and only the e2e exercises a real binary.
//
// `spawn` is always called with an args ARRAY and no shell option — never
// shell-interpolated. `spawnFn` itself is injectable too, purely so this
// module's own unit tests can drive a fake child process without a real
// ffmpeg on PATH.
import { spawn as defaultSpawn } from "node:child_process";

import { DarkroomError } from "./errors.mjs";

const STDERR_TAIL = 4096; // chars of stderr kept for the ffmpeg-failed error detail

function collect(child, wantStdout) {
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    const stdoutChunks = wantStdout ? [] : null;

    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    if (wantStdout) {
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    }
    child.on("error", reject); // e.g. the ffmpeg binary itself is missing
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new DarkroomError("ffmpeg-failed", stderr.slice(-STDERR_TAIL)));
        return;
      }
      resolve(wantStdout ? { stdout: Buffer.concat(stdoutChunks), stderr } : { stderr });
    });
  });
}

function streamCollect(child, onChunk) {
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.stdout.on("data", onChunk);
    child.on("error", reject);
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        reject(new DarkroomError("ffmpeg-failed", stderr.slice(-STDERR_TAIL)));
        return;
      }
      resolve({ stderr });
    });
  });
}

/**
 * makeRunner(bin, spawnFn) → { run(args), capture(args), stream(args, onChunk) }
 *
 * - run(args) → Promise<{stderr}> — stdout is ignored/discarded.
 * - capture(args) → Promise<{stdout, stderr}> — stdout collected as a
 *   Buffer (binary-safe; decodePcm reads f32le samples straight out of it).
 * - stream(args, onChunk) → Promise<{stderr}> — stdout delivered chunk by
 *   chunk to `onChunk` as it arrives, never buffered here (the window-limited
 *   decode's whole point); chunks split at arbitrary byte boundaries.
 *
 * All reject with `DarkroomError("ffmpeg-failed", <stderr tail>)` on a
 * non-zero exit code.
 */
export function makeRunner(bin = "ffmpeg", spawnFn = defaultSpawn) {
  function spawnFor(args, wantStdout) {
    const child = spawnFn(bin, args, {
      stdio: ["ignore", wantStdout ? "pipe" : "ignore", "pipe"],
    });
    return collect(child, wantStdout);
  }

  return {
    run(args) {
      return spawnFor(args, false);
    },
    capture(args) {
      return spawnFor(args, true);
    },
    stream(args, onChunk) {
      const child = spawnFn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      return streamCollect(child, onChunk);
    },
  };
}
