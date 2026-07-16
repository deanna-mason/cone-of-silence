import { describe, expect, it, vi } from "vitest";
import { JobRunner } from "../src/studio/runner.js";
import { FakeRecordingStore } from "./fakes.js";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingDir, sourcePath } from "../src/studio/paths.js";

const MEASURE_JSON = `frame=... blah\n{\n"input_i" : "-23.06",\n"input_tp" : "-5.20",\n"input_lra" : "9.90",\n"input_thresh" : "-33.53",\n"target_offset" : "0.31"\n}\n`;

describe("JobRunner", () => {
  it("drains the queue one at a time: measure → apply → waveform → done", async () => {
    const calls: string[][] = [];
    const runFfmpeg = async (args: string[]) => {
      calls.push(args);
      const isMeasure = args.join(" ").includes("print_format=json");
      return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
    };
    const store = new FakeRecordingStore();
    const a = await store.create("u1", "one.mp3", ".mp3");
    const b = await store.create("u1", "two.mp3", ".mp3");
    const runner = new JobRunner(store, { uploadDir: "/up", rnnoiseModel: "/m/std.rnnn", runFfmpeg });
    runner.kick();
    runner.kick(); // idempotent — must not double-process
    await vi.waitFor(async () => expect((await store.get(b.id))?.status).toBe("done"));
    expect((await store.get(a.id))?.status).toBe("done");
    expect(calls).toHaveLength(6); // 3 per recording
    expect(calls[1]?.join(" ")).toContain("measured_I=-23.06"); // apply consumed the measure
  });

  it("a failing ffmpeg marks error with a stage-only message, keeps stderr out of it, and logs the detail server-side", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = new FakeRecordingStore();
      const a = await store.create("u1", "one.mp3", ".mp3");
      const b = await store.create("u1", "two.mp3", ".mp3");
      const calls: string[][] = [];
      const runFfmpeg = async (args: string[]) => {
        calls.push(args);
        const isMeasure = args.join(" ").includes("print_format=json");
        // first recording's measure call fails; everything else succeeds
        if (isMeasure && args.some((arg) => arg.includes(a.id))) {
          return { code: 1, stderr: "boom /opt/cone-of-silence/uploads/u1/one/source.mp3" };
        }
        return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
      };
      const runner = new JobRunner(store, { uploadDir: "/up", rnnoiseModel: "/m/std.rnnn", runFfmpeg });
      runner.kick();
      await vi.waitFor(async () => expect((await store.get(b.id))?.status).toBe("done"));
      const recA = await store.get(a.id);
      expect(recA?.status).toBe("error");
      expect(recA?.error).toBe("enhancement failed at the measure pass");
      expect(recA?.error).not.toContain("boom");
      expect((await store.get(b.id))?.status).toBe("done");
      // full detail, including the stderr tail, goes to the server log only
      expect(errorSpy).toHaveBeenCalledWith(
        "[runner]",
        a.id,
        expect.stringContaining("boom /opt/cone-of-silence/uploads/u1/one/source.mp3"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("recoverAndKick flips stale processing rows back to queued and drains them", async () => {
    const store = new FakeRecordingStore();
    const stale = await store.create("u1", "stale.mp3", ".mp3");
    // simulate a crash mid-job: the row was left in "processing" with no runner alive to finish it
    await store.setStatus(stale.id, "processing");

    const calls: string[][] = [];
    const runFfmpeg = async (args: string[]) => {
      calls.push(args);
      const isMeasure = args.join(" ").includes("print_format=json");
      return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
    };
    const runner = new JobRunner(store, { uploadDir: "/up", rnnoiseModel: "/m/std.rnnn", runFfmpeg });

    await runner.recoverAndKick();
    await vi.waitFor(async () => expect((await store.get(stale.id))?.status).toBe("done"));
    expect(calls).toHaveLength(3); // measure, apply, waveform
  });

  it("kick() drains quietly when store.claimNextQueued rejects; retries on next kick()", async () => {
    // Subclass to reject once on claimNextQueued
    class ErrorFirstRecordingStore extends FakeRecordingStore {
      private callCount = 0;
      async claimNextQueued() {
        this.callCount++;
        if (this.callCount === 1) {
          return Promise.reject(new Error("db down"));
        }
        return super.claimNextQueued();
      }
    }

    const store = new ErrorFirstRecordingStore();
    const rec = await store.create("u1", "test.mp3", ".mp3");

    const calls: string[][] = [];
    const runFfmpeg = async (args: string[]) => {
      calls.push(args);
      const isMeasure = args.join(" ").includes("print_format=json");
      return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
    };

    const runner = new JobRunner(store, { uploadDir: "/up", rnnoiseModel: "/m/std.rnnn", runFfmpeg });

    // First kick() hits the rejection — drain returns quietly
    runner.kick();
    await vi.waitFor(async () => expect((await store.get(rec.id))?.status).toBe("queued"));
    // Wait for the first drain's finally handler to set running = false
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second kick() retries — should process normally
    runner.kick();
    await vi.waitFor(async () => expect((await store.get(rec.id))?.status).toBe("done"));
    expect(calls).toHaveLength(3); // measure, apply, waveform
  });

  it("deletes the source file after a successful enhance; keeps it when the job errors", async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), "cos-runner-"));
    const store = new FakeRecordingStore();
    const ok = await store.create("u1", "one.mp3", ".mp3");
    const bad = await store.create("u1", "two.mp3", ".mp3");
    for (const rec of [ok, bad]) {
      const dir = recordingDir(uploadDir, "u1", rec.id);
      await mkdir(dir, { recursive: true });
      await writeFile(sourcePath(dir, ".mp3"), "bytes");
    }
    const runFfmpeg = async (args: string[]) => {
      const isMeasure = args.join(" ").includes("print_format=json");
      if (isMeasure && args.some((a) => a.includes(bad.id))) return { code: 1, stderr: "boom" };
      return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
    };
    const runner = new JobRunner(store, { uploadDir, rnnoiseModel: "/m/std.rnnn", runFfmpeg });
    runner.kick();
    await vi.waitFor(async () => expect((await store.get(ok.id))?.status).toBe("done"));
    await vi.waitFor(async () => expect((await store.get(bad.id))?.status).toBe("error"));
    await expect(stat(sourcePath(recordingDir(uploadDir, "u1", ok.id), ".mp3"))).rejects.toThrow();
    await expect(stat(sourcePath(recordingDir(uploadDir, "u1", bad.id), ".mp3"))).resolves.toBeTruthy();
  });
});
