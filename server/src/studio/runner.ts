import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RecordingStore } from "./types.js";
import { applyArgs, measureArgs, parseLoudnorm, waveformArgs } from "./ffmpegArgs.js";
import { ENHANCED_NAME, recordingDir, sourcePath, WAVEFORM_NAME } from "./paths.js";

export type FfmpegRunner = (args: string[]) => Promise<{ code: number; stderr: string }>;

const STDERR_CAP = 64 * 1024;

export const spawnFfmpeg: FfmpegRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_CAP);
    });
    child.on("error", reject); // ffmpeg binary missing
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });

export interface RunnerOptions {
  uploadDir: string;
  rnnoiseModel: string;
  runFfmpeg?: FfmpegRunner;
}

export class JobRunner {
  private running = false;
  private readonly runFfmpeg: FfmpegRunner;

  constructor(
    private readonly store: RecordingStore,
    private readonly opts: RunnerOptions,
  ) {
    this.runFfmpeg = opts.runFfmpeg ?? spawnFfmpeg;
  }

  kick(): void {
    if (this.running) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
    });
  }

  async recoverAndKick(): Promise<void> {
    await this.store.recoverStale();
    this.kick();
  }

  private async drain(): Promise<void> {
    for (;;) {
      let job;
      try {
        job = await this.store.claimNextQueued();
      } catch {
        return; // store down — the next kick() retries
      }
      if (!job) return;
      try {
        await this.process(job.userId, job.id, job.sourceExt);
        await this.store.setStatus(job.id, "done");
      } catch (err) {
        const message = err instanceof Error ? err.message.slice(0, 300) : "processing failed";
        await this.store.setStatus(job.id, "error", message).catch(() => {});
      }
    }
  }

  private async process(userId: string, id: string, sourceExt: string): Promise<void> {
    const dir = recordingDir(this.opts.uploadDir, userId, id);
    const source = sourcePath(dir, sourceExt);
    const model = this.opts.rnnoiseModel;

    const measure = await this.runFfmpeg(measureArgs(source, model));
    if (measure.code !== 0) throw new Error(`measure pass failed: ${measure.stderr.slice(-200)}`);
    const m = parseLoudnorm(measure.stderr);

    const enhanced = join(dir, ENHANCED_NAME);
    const apply = await this.runFfmpeg(applyArgs(source, model, m, enhanced));
    if (apply.code !== 0) throw new Error(`enhance pass failed: ${apply.stderr.slice(-200)}`);

    const wave = await this.runFfmpeg(waveformArgs(enhanced, join(dir, WAVEFORM_NAME)));
    if (wave.code !== 0) throw new Error(`waveform failed: ${wave.stderr.slice(-200)}`);
  }
}
