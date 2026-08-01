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
