import { describe, expect, it, vi } from "vitest";
import { JobRunner } from "../src/studio/runner.js";
import { FakeRecordingStore } from "./fakes.js";

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

  it("a failing ffmpeg marks error with a message and continues to the next job", async () => {
    const store = new FakeRecordingStore();
    const a = await store.create("u1", "one.mp3", ".mp3");
    const b = await store.create("u1", "two.mp3", ".mp3");
    const calls: string[][] = [];
    const runFfmpeg = async (args: string[]) => {
      calls.push(args);
      const isMeasure = args.join(" ").includes("print_format=json");
      // first recording's measure call fails; everything else succeeds
      if (isMeasure && args.some((arg) => arg.includes(a.id))) {
        return { code: 1, stderr: "boom" };
      }
      return { code: 0, stderr: isMeasure ? MEASURE_JSON : "" };
    };
    const runner = new JobRunner(store, { uploadDir: "/up", rnnoiseModel: "/m/std.rnnn", runFfmpeg });
    runner.kick();
    await vi.waitFor(async () => expect((await store.get(b.id))?.status).toBe("done"));
    const recA = await store.get(a.id);
    expect(recA?.status).toBe("error");
    expect(recA?.error).toContain("boom");
    expect((await store.get(b.id))?.status).toBe("done");
  });

  it("recoverAndKick flips stale processing rows back to queued and drains them", async () => {
    const store = new FakeRecordingStore();
    const stale = await store.create("u1", "stale.mp3", ".mp3");
    // simulate a crash mid-job: the row was left in "processing" with no runner alive to finish it
    const raw = store.recordings.find((r) => r.id === stale.id);
    if (!raw) throw new Error("seed row missing");
    raw.status = "processing";

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
});
