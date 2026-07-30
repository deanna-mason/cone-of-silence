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

/** Resolves once, the first time the wrapped MediaRecorder's onstop fires. */
function onStopPromise(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    recorder.onstop = () => resolve();
  });
}

export class TakeRecorder {
  private readonly writers: { video: PartWriter; audio: PartWriter };
  private readonly onFaultCb: (f: RecorderFault, detail: string) => void;
  private readonly firedFaults = new Set<RecorderFault>();
  private readonly videoRecorder: MediaRecorder;
  private readonly audioRecorder: MediaRecorder;
  private readonly videoStopped: Promise<void>;
  private readonly audioStopped: Promise<void>;

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
    this.videoStopped = onStopPromise(this.videoRecorder);
    this.audioStopped = onStopPromise(this.audioRecorder);
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

  async stop(): Promise<{ video: SidecarEntry[]; audio: SidecarEntry[] }> {
    if (this.state !== "rolling") throw new Error("TakeRecorder.stop() called while not rolling");
    this.state = "stopped";

    this.videoRecorder.stop();
    this.audioRecorder.stop();

    // MediaRecorder.stop() flushes a final dataavailable before onstop; by
    // waiting for onstop first, that final blob's append() is already
    // enqueued on the writer's chain by the time finish() is called below.
    await this.videoStopped;
    await this.audioStopped;

    const [video, audio] = await Promise.all([
      this.finishWriter(this.writers.video),
      this.finishWriter(this.writers.audio),
    ]);
    return { video, audio };
  }
}
