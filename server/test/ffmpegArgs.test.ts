import { describe, expect, it } from "vitest";
import { applyArgs, chainFilter, measureArgs, parseLoudnorm, waveformArgs } from "../src/studio/ffmpegArgs.js";

const M = "/models/std.rnnn";

describe("ffmpeg args (Deanna's enhance chain, ported verbatim)", () => {
  it("chain matches enhance-audio.sh order: highpass→arnndn→deesser→acompressor→equalizer", () => {
    expect(chainFilter(M)).toBe(
      "highpass=f=80," +
        `arnndn=m=${M},` +
        "deesser=i=0.4," +
        "acompressor=threshold=-18dB:ratio=3:attack=15:release=250:makeup=2," +
        "equalizer=f=4000:width_type=o:width=1.2:g=2",
    );
  });

  it("measure pass targets -16 LUFS json and null output", () => {
    const args = measureArgs("/in/source.mp3", M);
    expect(args.join(" ")).toContain("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    expect(args.slice(-2)).toEqual(["null", "-"]);
  });

  it("apply pass embeds measured values, strips video, outputs 48k aac 192k", () => {
    const m = { inputI: "-23.1", inputTp: "-5.2", inputLra: "9.9", inputThresh: "-33.5" };
    const joined = applyArgs("/in/source.mp4", M, m, "/out/enhanced.m4a").join(" ");
    for (const frag of ["measured_I=-23.1", "measured_TP=-5.2", "measured_LRA=9.9",
      "measured_thresh=-33.5", "linear=true", "-vn", "-ar 48000", "-c:a aac", "-b:a 192k"]) {
      expect(joined).toContain(frag);
    }
  });

  it("waveform renders one brass-on-transparent frame", () => {
    expect(waveformArgs("/x/enhanced.m4a", "/x/waveform.png").join(" "))
      .toContain("showwavespic=s=1200x240:colors=0xC79A3B");
  });

  it("parseLoudnorm digs the json out of noisy stderr and rejects garbage", () => {
    const stderr = `frame=... blah\n{\n"input_i" : "-23.06",\n"input_tp" : "-5.20",\n"input_lra" : "9.90",\n"input_thresh" : "-33.53",\n"target_offset" : "0.31"\n}\n`;
    expect(parseLoudnorm(stderr)).toEqual({
      inputI: "-23.06", inputTp: "-5.20", inputLra: "9.90", inputThresh: "-33.53",
    });
    expect(() => parseLoudnorm("no json here")).toThrow();
  });
});
