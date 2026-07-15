export interface LoudnormMeasurement {
  inputI: string;
  inputTp: string;
  inputLra: string;
  inputThresh: string;
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

export function measureArgs(input: string, model: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-i", input,
    "-af", `${chainFilter(model)},${LOUDNORM_TARGET}:print_format=json`,
    "-f", "null", "-",
  ];
}

export function applyArgs(input: string, model: string, m: LoudnormMeasurement, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-i", input, "-vn",
    "-af",
    `${chainFilter(model)},${LOUDNORM_TARGET}:measured_I=${m.inputI}:measured_TP=${m.inputTp}` +
      `:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:linear=true`,
    "-ar", "48000", "-c:a", "aac", "-b:a", "192k", out,
  ];
}

export function waveformArgs(input: string, out: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-i", input,
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
  };
}
