// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DarkroomError } from "../scripts/darkroom/errors.mjs";
import { makeRunner } from "../scripts/darkroom/runner.mjs";
import { decodePcm, decodeArgs } from "../scripts/darkroom/decode.mjs";
import { reassemble, remuxArgs } from "../scripts/darkroom/concat.mjs";
import { driftRatio, remoteAudioFilter, remoteVideoSetpts, alignment } from "../scripts/darkroom/drift.mjs";
import { SAMPLE_RATE } from "../scripts/darkroom/tone.mjs";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "darkroom-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("drift.mjs", () => {
  it("driftRatio: local span 6.000s, remote span 5.9988s → 1.000200 ±1e-9", () => {
    const local = { start: 0, end: 6.0 };
    const remote = { start: 0, end: 5.9988 };

    // 6.000/5.9988 is not exactly 1.0002 (it's 1.000200040008...) — "1.000200"
    // in the brief is a 6-decimal readout, not the literal value. Compare
    // against the same expression computed independently, to 1e-9.
    expect(driftRatio(local, remote)).toBeCloseTo(6.0 / 5.9988, 9);
  });

  // D23 (Task 6 review, CRITICAL 2): the plan/brief's pinned literal
  // "asetrate=48009.600" (SAMPLE_RATE*ratio) was a plan-text defect — it
  // compresses an already-short remote track further instead of stretching
  // it to match local, doubling the drift error. The corrected form divides
  // by ratio: 48000/1.0002 = 47990.40192... -> "47990.402".
  it("remoteAudioFilter(1.0002) === 'asetrate=47990.402,aresample=48000' (D23: divide by ratio)", () => {
    expect(remoteAudioFilter(1.0002)).toBe("asetrate=47990.402,aresample=48000");
  });

  // Uses the SAME ratio as the remoteAudioFilter test above (1.0002), not
  // its reciprocal (0.9998) — the original test fed remoteVideoSetpts the
  // reciprocal of what remoteAudioFilter got, which is exactly how the
  // CRITICAL 2 direction bug went unnoticed (two formulas each "looked"
  // internally consistent while silently correcting in opposite real-world
  // directions). See the direction-pinning test below for the cross-check.
  it("remoteVideoSetpts(1.0002) === 'setpts=PTS*1.000200000'", () => {
    expect(remoteVideoSetpts(1.0002)).toBe("setpts=PTS*1.000200000");
  });

  it("D23 direction pin: remoteAudioFilter and remoteVideoSetpts, given the SAME ratio, correct in the SAME direction — corrected spans converge on local's", () => {
    const localSpanS = 6.0;
    const remoteSpanS = 5.9988;
    const ratio = driftRatio({ start: 0, end: localSpanS }, { start: 0, end: remoteSpanS });

    // asetrate=SAMPLE_RATE/ratio reinterprets N samples at a NEW rate of
    // SAMPLE_RATE/ratio, giving a new duration of N/(SAMPLE_RATE/ratio) =
    // originalDuration * ratio.
    expect(remoteAudioFilter(ratio)).toBe(`asetrate=${(SAMPLE_RATE / ratio).toFixed(3)},aresample=${SAMPLE_RATE}`);
    const correctedAudioDurationS = remoteSpanS * ratio;
    expect(correctedAudioDurationS).toBeCloseTo(localSpanS, 6);

    // setpts=PTS*ratio scales every presentation timestamp by ratio, i.e.
    // the SAME time-stretch factor — video and audio must correct in the
    // same direction or lip-sync drifts further apart across the episode
    // instead of converging.
    expect(remoteVideoSetpts(ratio)).toBe(`setpts=PTS*${ratio.toFixed(9)}`);
    const correctedVideoDurationS = remoteSpanS * ratio;
    expect(correctedVideoDurationS).toBeCloseTo(localSpanS, 6);

    expect(correctedAudioDurationS).toBeCloseTo(correctedVideoDurationS, 9);
  });

  it("alignment: remote mark earlier by 480 samples → {delayMs: 10, who:'remote'}", () => {
    const localStartSample = 480000;
    const remoteStartSampleCorrected = localStartSample - 480;

    expect(alignment(localStartSample, remoteStartSampleCorrected)).toEqual({
      delayMs: 10,
      who: "remote",
    });
  });

  it("alignment: local mark earlier → who:'local'", () => {
    const localStartSample = 480000;
    const remoteStartSampleCorrected = localStartSample + 960;

    expect(alignment(localStartSample, remoteStartSampleCorrected)).toEqual({
      delayMs: 20,
      who: "local",
    });
  });
});

describe("concat.mjs", () => {
  it("reassemble concatenates in sidecar order and byte count (3 tiny parts, temp dir)", async () => {
    const srcDir = tmpRoot;
    const outPath = path.join(tmpRoot, "out.webm");
    const partA = Buffer.from("AAAA");
    const partB = Buffer.from("BB");
    const partC = Buffer.from("CCCCCC");
    await fsp.writeFile(path.join(srcDir, "audio.part000"), partA);
    await fsp.writeFile(path.join(srcDir, "audio.part001"), partB);
    await fsp.writeFile(path.join(srcDir, "audio.part002"), partC);
    const entries = [{ name: "audio.part000" }, { name: "audio.part001" }, { name: "audio.part002" }];

    await reassemble(entries, srcDir, outPath);

    const result = await fsp.readFile(outPath);
    expect(result).toEqual(Buffer.concat([partA, partB, partC]));
    expect(result.length).toBe(partA.length + partB.length + partC.length);
  });

  it("reassemble: missing middle part → rejects, outPath absent, write stream destroyed (no leaked fd)", async () => {
    const srcDir = tmpRoot;
    const outPath = path.join(tmpRoot, "out-fail.webm");
    await fsp.writeFile(path.join(srcDir, "audio.part000"), Buffer.from("AAAA"));
    // audio.part001 deliberately absent from disk (listed but missing).
    await fsp.writeFile(path.join(srcDir, "audio.part002"), Buffer.from("CC"));
    const entries = [{ name: "audio.part000" }, { name: "audio.part001" }, { name: "audio.part002" }];

    let capturedStream: fs.WriteStream | null = null;
    const original = fs.createWriteStream.bind(fs);
    const spy = vi.spyOn(fs, "createWriteStream").mockImplementation((...args: Parameters<typeof fs.createWriteStream>) => {
      const stream = (original as (...a: unknown[]) => fs.WriteStream)(...args);
      capturedStream = stream;
      return stream;
    });

    try {
      await expect(reassemble(entries, srcDir, outPath)).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    await expect(fsp.access(outPath)).rejects.toThrow();
    expect(capturedStream).not.toBeNull();
    expect(capturedStream!.destroyed).toBe(true);
  });

  it("remuxArgs is exactly the copy-remux argv", () => {
    expect(remuxArgs("/tmp/in.webm", "/tmp/out.webm")).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/tmp/in.webm",
      "-c",
      "copy",
      "/tmp/out.webm",
    ]);
  });
});

describe("decode.mjs", () => {
  it("decodePcm builds the exact f32le argv and parses bytes → Float32Array", async () => {
    const samples = [0, 0.5, -0.5, 1];
    const buf = Buffer.alloc(samples.length * 4);
    samples.forEach((s, i) => buf.writeFloatLE(s, i * 4));

    let capturedArgs: string[] | null = null;
    const fakeRunner = {
      run: async () => ({ stderr: "" }),
      capture: async (args: string[]) => {
        capturedArgs = args;
        return { stdout: buf, stderr: "" };
      },
    };

    const pcm = await decodePcm(fakeRunner, "/vault/take/audio.webm");

    expect(capturedArgs).toEqual(decodeArgs("/vault/take/audio.webm"));
    expect(capturedArgs).toEqual([
      "-hide_banner",
      "-nostdin",
      "-i",
      "/vault/take/audio.webm",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    expect(pcm).toBeInstanceOf(Float32Array);
    expect(Array.from(pcm)).toEqual(samples);
  });
});

describe("runner.mjs", () => {
  function makeFakeChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }

  it("non-zero exit → DarkroomError ffmpeg-failed carrying stderr tail", async () => {
    const child = makeFakeChild();
    const spawnFn = (() => child) as unknown as typeof defaultSpawn;
    const runner = makeRunner("ffmpeg", spawnFn);

    const runPromise = runner.run(["-i", "bogus.webm"]);
    child.stderr.emit("data", Buffer.from("some ffmpeg error output\n"));
    child.emit("close", 1);

    await expect(runPromise).rejects.toBeInstanceOf(DarkroomError);
    await expect(runPromise.catch((e) => e as DarkroomError)).resolves.toMatchObject({ code: "ffmpeg-failed" });
    const err = await runPromise.catch((e) => e as DarkroomError);
    expect(err.message).toContain("some ffmpeg error output");
  });

  it("zero exit resolves with collected stderr", async () => {
    const child = makeFakeChild();
    const spawnFn = (() => child) as unknown as typeof defaultSpawn;
    const runner = makeRunner("ffmpeg", spawnFn);

    const runPromise = runner.run(["-i", "ok.webm"]);
    child.stderr.emit("data", Buffer.from("progress info\n"));
    child.emit("close", 0);

    await expect(runPromise).resolves.toEqual({ stderr: "progress info\n" });
  });

  it("capture collects stdout as a Buffer alongside stderr", async () => {
    const child = makeFakeChild();
    const spawnFn = (() => child) as unknown as typeof defaultSpawn;
    const runner = makeRunner("ffmpeg", spawnFn);

    const capturePromise = runner.capture(["-i", "ok.webm", "-f", "f32le", "pipe:1"]);
    child.stdout.emit("data", Buffer.from([1, 2, 3, 4]));
    child.stderr.emit("data", Buffer.from("info\n"));
    child.emit("close", 0);

    const result = await capturePromise;
    expect(result.stdout).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(result.stderr).toBe("info\n");
  });

  it("run spawns with the given bin and args array, never a shell", async () => {
    const child = makeFakeChild();
    let capturedCall: unknown[] | null = null;
    const spawnFn = ((...args: unknown[]) => {
      capturedCall = args;
      return child;
    }) as unknown as typeof defaultSpawn;
    const runner = makeRunner("ffmpeg", spawnFn);

    const runPromise = runner.run(["-hide_banner", "-i", "in.webm"]);
    child.emit("close", 0);
    await runPromise;

    expect(capturedCall![0]).toBe("ffmpeg");
    expect(capturedCall![1]).toEqual(["-hide_banner", "-i", "in.webm"]);
    const opts = capturedCall![2] as Record<string, unknown>;
    expect(opts.shell).not.toBe(true);
  });
});
