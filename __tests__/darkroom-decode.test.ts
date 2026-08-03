// @vitest-environment node
//
// 5C punch list: window-limited PCM decode. A 40-min take decoded whole is
// ~460MB of f32 samples buffered TWICE (runner.capture's Buffer + the
// Float32Array) per stream — ~2GB peak across the two streams — while
// findMarks only ever searches a SEARCH_WINDOW_S window at each end.
// decodeMarkWindows streams the decode, keeping just a head window, a tail
// ring, and the running sample count. Chunks arrive at arbitrary byte
// boundaries (a pipe does not respect float alignment), so every test here
// feeds deliberately misaligned chunk sizes.
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";

import { decodeMarkWindows, decodeArgs } from "../scripts/darkroom/decode.mjs";
import { makeRunner } from "../scripts/darkroom/runner.mjs";
import { DarkroomError } from "../scripts/darkroom/errors.mjs";

/** Ramp pcm: sample i = fround(i / n) — every index distinguishable, so a
 *  window copied from the wrong offset can't accidentally match. */
function rampPcm(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => Math.fround(i / n));
}

/** A fake runner whose stream() replays `pcm` as f32le bytes in fixed-size
 *  chunks that do NOT divide 4 — pinning the cross-chunk float carry. */
function fakeStreamRunner(pcm: Float32Array, chunkBytes = 7) {
  const buf = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length; i++) buf.writeFloatLE(pcm[i]!, i * 4);
  const argsSeen: string[][] = [];
  return {
    argsSeen,
    async stream(args: string[], onChunk: (c: Buffer) => void): Promise<{ stderr: string }> {
      argsSeen.push(args);
      for (let off = 0; off < buf.length; off += chunkBytes) {
        onChunk(buf.subarray(off, Math.min(off + chunkBytes, buf.length)));
      }
      return { stderr: "" };
    },
  };
}

describe("decode.mjs — decodeMarkWindows", () => {
  it("long input: head window, unrolled tail ring, tailStart and totalSamples all exact across misaligned chunks", async () => {
    const pcm = rampPcm(3000);
    const runner = fakeStreamRunner(pcm, 7);
    const win = await decodeMarkWindows(runner, "/tmp/a.webm", 1000);
    expect(win.full).toBeUndefined();
    expect(win.totalSamples).toBe(3000);
    expect(win.tailStart).toBe(2000);
    expect(Array.from(win.head!)).toEqual(Array.from(pcm.subarray(0, 1000)));
    expect(Array.from(win.tail!)).toEqual(Array.from(pcm.subarray(2000)));
  });

  it("decodes with the same ffmpeg argv as the full decode — same file, same format contract", async () => {
    const runner = fakeStreamRunner(rampPcm(10), 4);
    await decodeMarkWindows(runner, "/tmp/a.webm", 1000);
    expect(runner.argsSeen[0]).toEqual(decodeArgs("/tmp/a.webm"));
  });

  it("input at exactly two windows or shorter returns {full} — short takes keep the overlap-aware single-array path", async () => {
    const pcm = rampPcm(2000);
    const win = await decodeMarkWindows(fakeStreamRunner(pcm, 5), "/tmp/a.webm", 1000);
    expect(Array.from(win.full!)).toEqual(Array.from(pcm));
    expect(win.head).toBeUndefined();
  });

  it("one sample past two windows tips into windowed form", async () => {
    const pcm = rampPcm(2001);
    const win = await decodeMarkWindows(fakeStreamRunner(pcm, 3), "/tmp/a.webm", 1000);
    expect(win.full).toBeUndefined();
    expect(win.tailStart).toBe(1001);
    expect(win.tail![0]).toBe(pcm[1001]);
    expect(win.tail![999]).toBe(pcm[2000]);
  });

  it("input shorter than one window returns {full} of exactly totalSamples", async () => {
    const pcm = rampPcm(250);
    const win = await decodeMarkWindows(fakeStreamRunner(pcm, 9), "/tmp/a.webm", 1000);
    expect(win.full!.length).toBe(250);
    expect(Array.from(win.full!)).toEqual(Array.from(pcm));
  });
});

describe("runner.mjs — stream()", () => {
  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }

  it("delivers stdout chunks to onChunk as they arrive and resolves with stderr on exit 0", async () => {
    const child = fakeChild();
    const runner = makeRunner("ffmpeg", () => child as never);
    const seen: Buffer[] = [];
    const done = runner.stream(["-i", "x"], (c: Buffer) => seen.push(c));
    child.stdout.emit("data", Buffer.from("abcd"));
    child.stdout.emit("data", Buffer.from("efg"));
    child.stderr.emit("data", Buffer.from("progress line"));
    child.emit("close", 0);
    const { stderr } = await done;
    expect(Buffer.concat(seen).toString()).toBe("abcdefg");
    expect(stderr).toBe("progress line");
  });

  it("nonzero exit rejects DarkroomError(ffmpeg-failed) with the stderr tail, like run/capture", async () => {
    const child = fakeChild();
    const runner = makeRunner("ffmpeg", () => child as never);
    const done = runner.stream(["-i", "x"], () => {});
    child.stderr.emit("data", Buffer.from("boom detail"));
    child.emit("close", 1);
    await expect(done).rejects.toMatchObject({ code: "ffmpeg-failed" });
    await expect(done).rejects.toThrowError(/boom detail/);
  });
});
