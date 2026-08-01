// Byte-concat sidecar parts into one raw stream file, and the ffmpeg argv
// that remuxes it (rebuilds container cues/duration, no re-encode — the
// parts are MediaRecorder timeslice chunks whose byte-concat in sidecar
// order is already one valid WebM stream).
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * reassemble(entries, srcDir, outPath) → Promise<void>
 *
 * Streams each named part (in sidecar order) into `outPath`, one at a time
 * — no whole-part buffering, so this is safe for the ~64 MB parts the vault
 * produces.
 */
export async function reassemble(entries, srcDir, outPath) {
  const out = fs.createWriteStream(outPath);
  for (const entry of entries) {
    const src = fs.createReadStream(path.join(srcDir, entry.name));
    // eslint-disable-next-line no-await-in-loop -- parts must land in order
    await pipeline(src, out, { end: false });
  }
  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
    out.end();
  });
}

/** The exact argv that remuxes `inPath` into `outPath` via stream copy
 *  (rebuilds cues/duration; no re-encode). */
export function remuxArgs(inPath, outPath) {
  return ["-hide_banner", "-nostdin", "-y", "-i", inPath, "-c", "copy", outPath];
}
