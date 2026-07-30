// Take Recorder: streams the call's video (plus a backup copy of the
// recorded audio, spec §5A) and the audio-only feed into their respective
// PartWriters via two MediaRecorders, one blob every TIMESLICE_MS. A fault
// (disk-full append/finish, or the encoder itself erroring) is reported via
// onFault — latched once per cause — but never stops the recording; the
// watchdog/UI decide what to do about a fault.
import type { PartWriter, SidecarEntry } from "./vault";

export const VIDEO_BITS = 8_000_000;
export const AUDIO_BITS = 256_000;
export const TIMESLICE_MS = 1_000;

const H264_MIME = "video/webm;codecs=h264,opus";
const VP8_MIME = "video/webm;codecs=vp8,opus";
const AUDIO_MIME = "audio/webm;codecs=opus";

/** H.264 preferred as the cheapest encode (hardware support not assumed); vp8 otherwise. */
export function pickVideoMime(isSupported: (t: string) => boolean): string {
  return isSupported(H264_MIME) ? H264_MIME : VP8_MIME;
}

export interface TakeRecorderDeps {
  MediaRecorderCtor?: typeof MediaRecorder;
  isTypeSupported?: (t: string) => boolean;
  /** jsdom has no MediaStream constructor; tests inject a passthrough. */
  makeStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

export type RecorderFault = "encoder-error" | "disk-error";

function faultDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A recorder's stop latch. Resolves the first time its onstop fires — or the
 * moment `settle()` is called, for a recorder that is already inactive (a
 * fatal encoder error leaves it stopped, and its onstop will never fire
 * again). Without that escape hatch, stop() would await an event that can
 * never arrive and neither writer would ever be finished.
 */
interface StopLatch {
  done: Promise<void>;
  settle(): void;
}

function stopLatch(recorder: MediaRecorder): StopLatch {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  recorder.onstop = () => settle();
  return { done, settle };
}

export class TakeRecorder {
  private readonly writers: { video: PartWriter; audio: PartWriter };
  private readonly onFaultCb: (f: RecorderFault, detail: string) => void;
  private readonly firedFaults = new Set<RecorderFault>();
  private readonly videoRecorder: MediaRecorder;
  private readonly audioRecorder: MediaRecorder;
  private readonly videoLatch: StopLatch;
  private readonly audioLatch: StopLatch;

  state: "idle" | "rolling" | "stopped" = "idle";

  constructor(
    opts: {
      videoTrack: MediaStreamTrack;
      recordedAudioTrack: MediaStreamTrack;
      writers: { video: PartWriter; audio: PartWriter };
      onFault: (f: RecorderFault, detail: string) => void;
    },
    deps: TakeRecorderDeps = {},
  ) {
    this.writers = opts.writers;
    this.onFaultCb = opts.onFault;

    const MediaRecorderCtor = deps.MediaRecorderCtor ?? MediaRecorder;
    const isTypeSupported = deps.isTypeSupported ?? ((t: string) => MediaRecorder.isTypeSupported(t));
    const makeStream = deps.makeStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));

    const videoMime = pickVideoMime(isTypeSupported);
    const videoStream = makeStream([opts.videoTrack, opts.recordedAudioTrack]);
    const audioStream = makeStream([opts.recordedAudioTrack]);

    this.videoRecorder = new MediaRecorderCtor(videoStream, {
      mimeType: videoMime,
      videoBitsPerSecond: VIDEO_BITS,
      audioBitsPerSecond: AUDIO_BITS,
    });
    this.audioRecorder = new MediaRecorderCtor(audioStream, {
      mimeType: AUDIO_MIME,
      audioBitsPerSecond: AUDIO_BITS,
    });

    this.wireRecorder(this.videoRecorder, this.writers.video);
    this.wireRecorder(this.audioRecorder, this.writers.audio);

    // Installed up front (not inside stop()) so a dataavailable/onstop pair
    // that fires between construction and stop() is never missed.
    this.videoLatch = stopLatch(this.videoRecorder);
    this.audioLatch = stopLatch(this.audioRecorder);
  }

  private fault(kind: RecorderFault, detail: string): void {
    if (this.firedFaults.has(kind)) return;
    this.firedFaults.add(kind);
    this.onFaultCb(kind, detail);
  }

  private wireRecorder(recorder: MediaRecorder, writer: PartWriter): void {
    recorder.ondataavailable = (ev: BlobEvent) => {
      writer.append(ev.data).catch((err) => this.fault("disk-error", faultDetail(err)));
    };
    recorder.onerror = (ev: ErrorEvent) => {
      this.fault("encoder-error", faultDetail(ev.error ?? ev.message ?? ev));
    };
  }

  private async finishWriter(writer: PartWriter): Promise<SidecarEntry[]> {
    try {
      return await writer.finish();
    } catch (err) {
      this.fault("disk-error", faultDetail(err));
      throw err;
    }
  }

  bytes(): { video: number; audio: number } {
    return { video: this.writers.video.bytesWritten, audio: this.writers.audio.bytesWritten };
  }

  start(): void {
    if (this.state !== "idle") throw new Error("TakeRecorder.start() called while not idle");
    this.state = "rolling";
    this.videoRecorder.start(TIMESLICE_MS);
    this.audioRecorder.start(TIMESLICE_MS);
  }

  /**
   * Stops one recorder without letting it take the rest of the take down with
   * it. Only a recorder that is actually "recording" is stopped: calling
   * .stop() on one already killed by a fatal error is at best a no-op and, on
   * Chrome historically, an InvalidStateError throw — which, unguarded, would
   * abandon the other recorder AND both finish() calls, losing the healthy
   * stream's final part and both sidecars. The try/catch stands regardless
   * (browser variance is the whole point here). Either way the latch is
   * settled, because a recorder we did not stop will never fire onstop.
   */
  private stopOne(recorder: MediaRecorder, latch: StopLatch): void {
    try {
      if (recorder.state === "recording") {
        recorder.stop();
        return;
      }
    } catch (err) {
      this.fault("encoder-error", faultDetail(err));
    }
    latch.settle();
  }

  async stop(): Promise<{ video: SidecarEntry[]; audio: SidecarEntry[] }> {
    if (this.state !== "rolling") throw new Error("TakeRecorder.stop() called while not rolling");
    this.state = "stopped";

    this.stopOne(this.videoRecorder, this.videoLatch);
    this.stopOne(this.audioRecorder, this.audioLatch);

    // MediaRecorder.stop() flushes a final dataavailable before onstop; by
    // waiting for onstop first, that final blob's append() is already
    // enqueued on the writer's chain by the time finish() is called below.
    await this.videoLatch.done;
    await this.audioLatch.done;

    // BOTH writers are finished no matter what either recorder did — a dead
    // video stream still has committed parts that need a sidecar, and the
    // audio stream beside it is usually untouched. allSettled (not all) so a
    // second failure can never surface as an unhandled rejection; the first
    // failure is still what the caller sees.
    const [video, audio] = await Promise.allSettled([
      this.finishWriter(this.writers.video),
      this.finishWriter(this.writers.audio),
    ]);
    if (video.status === "rejected") throw video.reason;
    if (audio.status === "rejected") throw audio.reason;
    return { video: video.value, audio: audio.value };
  }
}
