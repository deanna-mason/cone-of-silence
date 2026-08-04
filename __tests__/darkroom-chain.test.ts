// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { DarkroomError } from "../scripts/darkroom/errors.mjs";
import {
  LOUDNORM_TARGET,
  chainFilter,
  measureStem,
  applyStemArgs,
  mixMeasureArgs,
  mixApplyArgs,
} from "../scripts/darkroom/chain.mjs";

const FFMPEG_ARGS_TS_PATH = fileURLToPath(new URL("../server/src/studio/ffmpegArgs.ts", import.meta.url));

const REAL_JSON = `{
    "input_i" : "-23.71",
    "input_tp" : "-6.54",
    "input_lra" : "5.10",
    "input_thresh" : "-33.71",
    "output_i" : "-16.01",
    "output_tp" : "-1.50",
    "output_lra" : "5.00",
    "output_thresh" : "-26.01",
    "normalization_type" : "dynamic",
    "target_offset" : "-0.01"
}`;

const DECOY_JSON = `{
    "input_i" : "-99.99",
    "input_tp" : "-9.99",
    "input_lra" : "9.99",
    "input_thresh" : "-99.99",
    "output_i" : "-16.01",
    "output_tp" : "-1.50",
    "output_lra" : "5.00",
    "output_thresh" : "-26.01",
    "normalization_type" : "dynamic",
    "target_offset" : "-9.99"
}`;

function cannedStderr(jsonBlock: string): string {
  return [
    "[Parsed_loudnorm_0 @ 0x7f8b1c008000] ",
    jsonBlock,
    "frame=  100 fps=25.0 q=-1.0 Lsize=N/A time=00:00:04.00 bitrate=N/A speed=8.1x",
  ].join("\n");
}

function fakeRunner(stderr: string) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return { stderr };
    },
  };
}

describe("chain.mjs — studio parity", () => {
  it("PARITY: chainFilter matches server/src/studio/ffmpegArgs.ts for model 'm.rnnn'", async () => {
    const server = await import("../server/src/studio/ffmpegArgs");
    expect(chainFilter("m.rnnn")).toBe(server.chainFilter("m.rnnn"));
    // server.LOUDNORM_TARGET is a module-private const (never exported) —
    // pinned instead via the two tests below: a live-import parity pin on
    // the exported measureArgs (which embeds LOUDNORM_TARGET char-for-char
    // in its -af string) plus a source-text extraction of the bare literal.
  });

  it("PARITY: measureStem's argv (no drift filter) equals server.measureArgs(input, model) — transitively pins LOUDNORM_TARGET", async () => {
    const server = await import("../server/src/studio/ffmpegArgs");
    const runner = fakeRunner(cannedStderr(REAL_JSON));

    await measureStem(runner, "/tmp/in.webm", "server/models/std.rnnn");

    expect(runner.calls[0]).toEqual(server.measureArgs("/tmp/in.webm", "server/models/std.rnnn"));
  });

  it("LOUDNORM_TARGET source-text pin: dark.LOUDNORM_TARGET matches the private constant's literal in ffmpegArgs.ts", () => {
    const source = fs.readFileSync(FFMPEG_ARGS_TS_PATH, "utf8");
    const match = source.match(/const LOUDNORM_TARGET = "([^"]+)";/);
    if (!match) {
      throw new Error(
        "LOUDNORM_TARGET declaration shape changed in server/src/studio/ffmpegArgs.ts — update this pin's regex",
      );
    }
    expect(LOUDNORM_TARGET).toBe(match[1]);
    expect(LOUDNORM_TARGET).toBe("loudnorm=I=-16:TP=-1.5:LRA=11");
  });
});

describe("chain.mjs — measureStem", () => {
  it("measureStem prepends the drift filter before the chain", async () => {
    const runner = fakeRunner(cannedStderr(REAL_JSON));
    const extraFilter = "asetrate=48009.600,aresample=48000";

    await measureStem(runner, "/tmp/remote.webm", "m.rnnn", extraFilter);

    const af = runner.calls[0][runner.calls[0].indexOf("-af") + 1];
    expect(af).toBe(`${extraFilter},${chainFilter("m.rnnn")},${LOUDNORM_TARGET}:print_format=json`);
  });

  it("measureStem omits the drift filter entirely when none is given", async () => {
    const runner = fakeRunner(cannedStderr(REAL_JSON));

    await measureStem(runner, "/tmp/local.webm", "m.rnnn");

    const af = runner.calls[0][runner.calls[0].indexOf("-af") + 1];
    expect(af).toBe(`${chainFilter("m.rnnn")},${LOUDNORM_TARGET}:print_format=json`);
  });

  it("measureStem parses ffmpeg's stderr loudnorm JSON (realistic canned block)", async () => {
    const runner = fakeRunner(cannedStderr(REAL_JSON));

    const m = await measureStem(runner, "/tmp/in.webm", "m.rnnn");

    expect(m).toEqual({
      input_i: "-23.71",
      input_tp: "-6.54",
      input_lra: "5.10",
      input_thresh: "-33.71",
      target_offset: "-0.01",
    });
  });

  it("measureStem parses the LAST {...} block when ffmpeg prints more than one", async () => {
    const stderr = [
      "[Parsed_loudnorm_0 @ 0x7f8b1c008000] ",
      DECOY_JSON,
      "frame=   50 fps=25.0 q=-1.0 Lsize=N/A time=00:00:02.00 bitrate=N/A speed=8.0x",
      "[Parsed_loudnorm_1 @ 0x7f8b1c009000] ",
      REAL_JSON,
    ].join("\n");
    const runner = fakeRunner(stderr);

    const m = await measureStem(runner, "/tmp/in.webm", "m.rnnn");

    expect(m.input_i).toBe("-23.71");
    expect(m.target_offset).toBe("-0.01");
  });

  it("missing loudnorm JSON keys → ffmpeg-failed", async () => {
    const badJson = `{
    "input_i" : "-23.71",
    "input_tp" : "-6.54",
    "input_lra" : "5.10"
}`;
    const runner = fakeRunner(cannedStderr(badJson));

    await expect(measureStem(runner, "/tmp/in.webm", "m.rnnn")).rejects.toBeInstanceOf(DarkroomError);
    await expect(measureStem(runner, "/tmp/in.webm", "m.rnnn").catch((e: any) => e)).resolves.toMatchObject({
      code: "ffmpeg-failed",
    });
  });

  it("no loudnorm JSON in stderr at all → ffmpeg-failed", async () => {
    const runner = fakeRunner("no json here, just plain ffmpeg chatter\n");

    await expect(measureStem(runner, "/tmp/in.webm", "m.rnnn").catch((e: any) => e)).resolves.toMatchObject({
      code: "ffmpeg-failed",
    });
  });
});

describe("chain.mjs — applyStemArgs", () => {
  const measurement = {
    input_i: "-23.71",
    input_tp: "-6.54",
    input_lra: "5.10",
    input_thresh: "-33.71",
    target_offset: "-0.01",
  };

  it("applyStemArgs carries all five measured_* values and linear=true", () => {
    const args = applyStemArgs("/tmp/in.webm", "m.rnnn", measurement, "/tmp/out.m4a");

    const af = args[args.indexOf("-af") + 1];
    expect(af).toBe(
      `${chainFilter("m.rnnn")},${LOUDNORM_TARGET}:measured_I=-23.71:measured_TP=-6.54:measured_LRA=5.10:measured_thresh=-33.71:offset=-0.01:linear=true`,
    );
  });

  it("applyStemArgs prepends the drift filter when given, and matches the full argv shape", () => {
    const extraFilter = "asetrate=48009.600,aresample=48000";
    const args = applyStemArgs("/tmp/remote.webm", "m.rnnn", measurement, "/tmp/out.m4a", extraFilter);

    expect(args).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/tmp/remote.webm",
      "-vn",
      "-af",
      `${extraFilter},${chainFilter("m.rnnn")},${LOUDNORM_TARGET}:measured_I=-23.71:measured_TP=-6.54:measured_LRA=5.10:measured_thresh=-33.71:offset=-0.01:linear=true`,
      "-ar",
      "48000",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "/tmp/out.m4a",
    ]);
  });
});

describe("chain.mjs — mix builders", () => {
  const measurement = {
    input_i: "-14.02",
    input_tp: "-1.80",
    input_lra: "4.00",
    input_thresh: "-24.02",
    target_offset: "0.02",
  };

  it("mix args: adelay per input, amix normalize=0, final measured loudnorm, aac 192k 48k", () => {
    const delayA = "adelay=10:all=1";
    const delayB = "adelay=0:all=1";

    const measureArgs = mixMeasureArgs("/tmp/a.m4a", "/tmp/b.m4a", delayA, delayB);
    const applyArgsOut = mixApplyArgs("/tmp/a.m4a", "/tmp/b.m4a", delayA, delayB, measurement, "/tmp/episode.m4a");

    const measureFilter = measureArgs[measureArgs.indexOf("-filter_complex") + 1];
    expect(measureFilter).toContain(`[0:a]${delayA}`);
    expect(measureFilter).toContain(`[1:a]${delayB}`);
    expect(measureFilter).toContain("amix=inputs=2:normalize=0");
    expect(measureFilter).toContain(`${LOUDNORM_TARGET}:print_format=json`);
    expect(measureArgs).toEqual([
      "-hide_banner",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/tmp/a.m4a",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/tmp/b.m4a",
      "-filter_complex",
      measureFilter,
      "-f",
      "null",
      "-",
    ]);

    const applyFilter = applyArgsOut[applyArgsOut.indexOf("-filter_complex") + 1];
    expect(applyFilter).toContain(`[0:a]${delayA}`);
    expect(applyFilter).toContain(`[1:a]${delayB}`);
    expect(applyFilter).toContain("amix=inputs=2:normalize=0");
    expect(applyFilter).toContain(
      `${LOUDNORM_TARGET}:measured_I=-14.02:measured_TP=-1.80:measured_LRA=4.00:measured_thresh=-24.02:offset=0.02:linear=true`,
    );
    expect(applyArgsOut).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/tmp/a.m4a",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/tmp/b.m4a",
      "-filter_complex",
      applyFilter,
      "-ar",
      "48000",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "/tmp/episode.m4a",
    ]);
  });
});
