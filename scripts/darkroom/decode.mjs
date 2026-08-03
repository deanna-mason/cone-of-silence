// Decodes any media file's audio to mono 48kHz 32-bit-float PCM via ffmpeg,
// for feeding to tone.mjs's matched filter. Takes an injected runner
// (runner.mjs's makeRunner shape) — never spawns ffmpeg itself.

/** The exact argv `decodePcm` runs: mono, 48kHz, raw float32 to stdout. */
export function decodeArgs(file) {
  return ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"];
}

/**
 * decodePcm(runner, file) → Promise<Float32Array>
 *
 * Runs ffmpeg via `runner.capture` and parses the raw f32le stdout bytes
 * into a Float32Array, sample by sample (avoids relying on the returned
 * Buffer's byteOffset being 4-byte aligned, which Node's internal buffer
 * pool does not guarantee).
 */
export async function decodePcm(runner, file) {
  const { stdout } = await runner.capture(decodeArgs(file));
  const sampleCount = Math.floor(stdout.length / 4);
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = stdout.readFloatLE(i * 4);
  }
  return pcm;
}

/**
 * decodeMarkWindows(runner, file, windowSamples) →
 *   Promise<{ full }                                  — total ≤ 2·window
 *          | { head, tail, tailStart, totalSamples }> — otherwise
 *
 * Window-limited variant of decodePcm for mark-finding (5C punch list): a
 * 40-min take is ~460MB of f32 samples buffered twice under capture(),
 * while tone.mjs only ever searches a fixed window at each end. This
 * streams the same ffmpeg decode (identical argv — see decodeArgs) and
 * keeps just the first `windowSamples` (head), a `windowSamples` ring of
 * the most recent samples (unrolled into `tail` at the end), and the
 * running total. Short inputs — anything the two windows would jointly
 * cover — come back as `{ full }` so tone.mjs's overlap-aware single-array
 * path handles them verbatim (the memory concern doesn't exist there).
 * Chunks arrive at arbitrary byte boundaries; a ≤3-byte carry stitches
 * floats split across chunks.
 */
export async function decodeMarkWindows(runner, file, windowSamples) {
  const head = new Float32Array(windowSamples);
  const ring = new Float32Array(windowSamples);
  let total = 0;
  let carry = Buffer.alloc(0);

  await runner.stream(decodeArgs(file), (chunk) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    for (let off = 0; off < usable; off += 4) {
      const sample = buf.readFloatLE(off);
      if (total < windowSamples) head[total] = sample;
      ring[total % windowSamples] = sample;
      total += 1;
    }
    carry = Buffer.from(buf.subarray(usable));
  });

  if (total <= windowSamples * 2) {
    const full = new Float32Array(total);
    full.set(head.subarray(0, Math.min(total, windowSamples)));
    for (let i = Math.max(0, total - windowSamples); i < total; i++) {
      full[i] = ring[i % windowSamples];
    }
    return { full };
  }

  const tailStart = total - windowSamples;
  const tail = new Float32Array(windowSamples);
  for (let i = 0; i < windowSamples; i++) {
    tail[i] = ring[(tailStart + i) % windowSamples];
  }
  return { head, tail, tailStart, totalSamples: total };
}
