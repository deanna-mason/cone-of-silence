export interface LoudnormMeasurement {
  inputI: string;
  inputTp: string;
  inputLra: string;
  inputThresh: string;
  targetOffset: string;
}

const LOUDNORM_TARGET = "loudnorm=I=-16:TP=-1.5:LRA=11";

export function chainFilter(model: string): string {
  return [
    "highpass=f=80",
    `arnndn=m=${model}`,
    "deesser=i=0.4",
    "acompressor=threshold=-18dB:ratio=3:attack=15:release=250:makeup=2",
    "equalizer=f=4000:width_type=o:width=1.2:g=2",
  ].join(",");
}

// Uploads are untrusted: ffmpeg auto-detects format from *content*, and some
// demuxers (concat, hls, subfile, image2…) can open external file://,http://
// resources. Without a protocol whitelist a crafted container could coerce a
// read of droplet secrets (/proc/self/environ) muxed into the served output, or
// SSRF. Pin every untrusted-input pass to local file + pipe only. (S6 F1.)
const INPUT_PROTOCOLS = ["-protocol_whitelist", "file,pipe"];

export function measureArgs(input: string, model: string): string[] {
  return [
    "-hide_banner", "-nostdin", ...INPUT_PROTOCOLS, "-i", input,
    "-af", `${chainFilter(model)},${LOUDNORM_TARGET}:print_format=json`,
    "-f", "null", "-",
  ];
}

export function applyArgs(input: string, model: string, m: LoudnormMeasurement, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", ...INPUT_PROTOCOLS, "-i", input, "-vn",
    "-af",
    // offset= from the measured target_offset — ffmpeg's own documented
    // 5-field two-pass recipe, matching the darkroom chain (chain.mjs).
    `${chainFilter(model)},${LOUDNORM_TARGET}:measured_I=${m.inputI}:measured_TP=${m.inputTp}` +
      `:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true`,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out,
  ];
}

export function waveformArgs(input: string, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", ...INPUT_PROTOCOLS, "-i", input,
    "-filter_complex", "showwavespic=s=1200x240:colors=0xC79A3B",
    "-frames:v", "1", out,
  ];
}

export function parseLoudnorm(stderr: string): LoudnormMeasurement {
  const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) throw new Error("loudnorm measurement json not found in ffmpeg output");
  const parsed = JSON.parse(match[0]) as Record<string, string>;
  const pick = (key: string): string => {
    const v = parsed[key];
    if (typeof v !== "string") throw new Error(`loudnorm json missing ${key}`);
    return v;
  };
  return {
    inputI: pick("input_i"),
    inputTp: pick("input_tp"),
    inputLra: pick("input_lra"),
    inputThresh: pick("input_thresh"),
    targetOffset: pick("target_offset"),
  };
}
