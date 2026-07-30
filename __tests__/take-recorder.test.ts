import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_BITS,
  TIMESLICE_MS,
  TakeRecorder,
  VIDEO_BITS,
  pickVideoMime,
  type RecorderFault,
} from "@/lib/podcast/recorder";
import type { PartWriter, SidecarEntry } from "@/lib/podcast/vault";

// ---------------------------------------------------------------------------
// Fake MediaRecorder: captures constructor args (stream + options), and lets
// a test drive ondataavailable/onstop/onerror by hand. Real MediaRecorder
// flushes a final dataavailable BEFORE onstop when stop() is called, and
// BOTH fire asynchronously (never in the same tick as the stop() call) —
// stop() here mirrors that with two chained queueMicrotask hops, deliberately
// NOT inline, so a recorder implementation that fails to actually await
// onstop before calling finish() shows up as a real test failure instead of
// passing by synchronous accident.
// ---------------------------------------------------------------------------
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: { error?: unknown; message?: string }) => void) | null = null;
  startCalls: number[] = [];
  stopCalled = false;
  /** Counts stop() ENTRIES, including the ones that throw — so a test can
   *  pin that a dead recorder is never even asked to stop, not merely that
   *  the resulting throw was swallowed. */
  stopAttempts = 0;
  finalBlob: Blob | null = null;
  /** Tracked like the real thing — a fatal error and a stop() both leave it
   *  "inactive", and stopping an inactive recorder is the throw this suite
   *  exists to pin (see emitError/stop below). */
  state: "inactive" | "recording" | "paused" = "inactive";

  constructor(
    public stream: unknown,
    public options: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number },
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    this.startCalls.push(timeslice!);
    this.state = "recording";
  }

  /** Test hook: queue a blob to be flushed automatically when stop() runs. */
  queueFinalBlob(blob: Blob): void {
    this.finalBlob = blob;
  }

  stop(): void {
    this.stopAttempts += 1;
    // Chrome's historical behaviour, and the whole point of the guard in
    // TakeRecorder.stopOne(): stopping an inactive recorder throws rather
    // than no-opping. If the production code ever calls this unguarded on a
    // recorder killed by onerror, the take's stop() blows up here.
    if (this.state !== "recording") {
      throw new DOMException("The MediaRecorder is not recording", "InvalidStateError");
    }
    this.state = "inactive";
    this.stopCalled = true;
    const finalBlob = this.finalBlob;
    // Two separate MACROtask hops (setTimeout, not queueMicrotask): a plain
    // microtask hop turned out to still race ahead of a writer.finish() call
    // chained only through microtasks (an all-microtask "no await" mutant of
    // TakeRecorder.stop() still passed). setTimeout-0 guarantees dataavailable
    // and onstop each land strictly after every pending microtask (including
    // any Promise.all/finish() chain a buggy stop() fires immediately) has
    // fully drained — so failing to actually await onstop is unmistakable.
    setTimeout(() => {
      if (finalBlob) this.ondataavailable?.({ data: finalBlob });
      setTimeout(() => {
        this.onstop?.();
      }, 0);
    }, 0);
  }

  emitData(blob: Blob): void {
    this.ondataavailable?.({ data: blob });
  }

  /** A MediaRecorder error is fatal: the recorder goes inactive. This fake
   *  deliberately does NOT fire onstop afterwards — the worst case, where
   *  anything still waiting on onstop waits forever. */
  emitError(err: unknown): void {
    this.state = "inactive";
    this.onerror?.({ error: err });
  }
}

function resetFakes(): void {
  FakeMediaRecorder.instances = [];
}

// ---------------------------------------------------------------------------
// Fake PartWriter: records every appended blob, exposes bytesWritten, and
// lets a test force append()/finish() to reject on demand.
// ---------------------------------------------------------------------------
function fakeWriter(name: "video" | "audio") {
  const appended: Blob[] = [];
  let failAppend: Error | null = null;
  let failFinish: Error | null = null;
  const sidecar: SidecarEntry[] = [{ name: `${name}.part000`, size: 1, sha256: "abc" }];

  const writer = {
    bytesWritten: 0,
    async append(blob: Blob): Promise<void> {
      if (failAppend) throw failAppend;
      appended.push(blob);
      writer.bytesWritten += blob.size;
    },
    async finish(): Promise<SidecarEntry[]> {
      if (failFinish) throw failFinish;
      return sidecar;
    },
  } as unknown as PartWriter;

  return {
    writer,
    appended,
    sidecar,
    setFailAppend: (err: Error | null) => {
      failAppend = err;
    },
    setFailFinish: (err: Error | null) => {
      failFinish = err;
    },
  };
}

function makeTracks() {
  const videoTrack = { kind: "video", id: "v1" } as unknown as MediaStreamTrack;
  const recordedAudioTrack = { kind: "audio", id: "a1" } as unknown as MediaStreamTrack;
  return { videoTrack, recordedAudioTrack };
}

// Passthrough: jsdom has no MediaStream constructor, so tests inject the
// track array itself in its place — the recorder never inspects it beyond
// handing it to MediaRecorderCtor.
const makeStream = (tracks: MediaStreamTrack[]) => tracks as unknown as MediaStream;

function buildRecorder(opts: {
  onFault?: (f: RecorderFault, detail: string) => void;
  isTypeSupported?: (t: string) => boolean;
}) {
  resetFakes();
  const { videoTrack, recordedAudioTrack } = makeTracks();
  const video = fakeWriter("video");
  const audio = fakeWriter("audio");
  const onFault = opts.onFault ?? vi.fn();
  const recorder = new TakeRecorder(
    {
      videoTrack,
      recordedAudioTrack,
      writers: { video: video.writer, audio: audio.writer },
      onFault,
    },
    {
      MediaRecorderCtor: FakeMediaRecorder as unknown as typeof MediaRecorder,
      isTypeSupported: opts.isTypeSupported ?? (() => true),
      makeStream,
    },
  );
  const [videoRecorder, audioRecorder] = FakeMediaRecorder.instances;
  return { recorder, videoRecorder: videoRecorder!, audioRecorder: audioRecorder!, video, audio, onFault };
}

describe("pickVideoMime", () => {
  it("prefers h264 when supported", () => {
    expect(pickVideoMime(() => true)).toBe("video/webm;codecs=h264,opus");
  });

  it("falls back to vp8 when h264 isn't supported", () => {
    expect(pickVideoMime(() => false)).toBe("video/webm;codecs=vp8,opus");
  });
});

describe("TakeRecorder construction", () => {
  it("picks h264 for the video recorder's mimeType when supported", () => {
    const { videoRecorder } = buildRecorder({ isTypeSupported: () => true });
    expect(videoRecorder.options.mimeType).toBe("video/webm;codecs=h264,opus");
  });

  it("falls back to vp8 for the video recorder's mimeType when h264 isn't supported", () => {
    const { videoRecorder } = buildRecorder({ isTypeSupported: () => false });
    expect(videoRecorder.options.mimeType).toBe("video/webm;codecs=vp8,opus");
  });

  it("constructs the video recorder with VIDEO_BITS and AUDIO_BITS (its backup audio track is high quality too)", () => {
    const { videoRecorder } = buildRecorder({});
    expect(videoRecorder.options.videoBitsPerSecond).toBe(VIDEO_BITS);
    expect(videoRecorder.options.audioBitsPerSecond).toBe(AUDIO_BITS);
  });

  it("constructs the audio recorder with AUDIO_BITS and mimeType audio/webm;codecs=opus", () => {
    const { audioRecorder } = buildRecorder({});
    expect(audioRecorder.options.audioBitsPerSecond).toBe(AUDIO_BITS);
    expect(audioRecorder.options.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("video recorder gets [videoTrack, recordedAudioTrack]; audio recorder gets [recordedAudioTrack] only", () => {
    const { videoRecorder, audioRecorder } = buildRecorder({});
    expect((videoRecorder.stream as unknown[]).length).toBe(2);
    expect((audioRecorder.stream as unknown[]).length).toBe(1);
  });
});

describe("TakeRecorder.start", () => {
  it("starts both recorders with TIMESLICE_MS", () => {
    const { recorder, videoRecorder, audioRecorder } = buildRecorder({});
    recorder.start();
    expect(videoRecorder.startCalls).toEqual([TIMESLICE_MS]);
    expect(audioRecorder.startCalls).toEqual([TIMESLICE_MS]);
    expect(recorder.state).toBe("rolling");
  });

  it("throws if called when not idle", () => {
    const { recorder } = buildRecorder({});
    recorder.start();
    expect(() => recorder.start()).toThrow();
  });
});

describe("TakeRecorder blob routing", () => {
  it("routes video blobs to the video writer and audio blobs to the audio writer", async () => {
    const { recorder, videoRecorder, audioRecorder, video, audio } = buildRecorder({});
    recorder.start();

    const videoBlob = new Blob([new Uint8Array(5)]);
    const audioBlob = new Blob([new Uint8Array(3)]);
    videoRecorder.emitData(videoBlob);
    audioRecorder.emitData(audioBlob);
    await Promise.resolve();
    await Promise.resolve();

    expect(video.appended).toEqual([videoBlob]);
    expect(audio.appended).toEqual([audioBlob]);
  });

  it("bytes() delegates to both writers' bytesWritten", async () => {
    const { recorder, videoRecorder, audioRecorder, video, audio } = buildRecorder({});
    recorder.start();
    videoRecorder.emitData(new Blob([new Uint8Array(5)]));
    audioRecorder.emitData(new Blob([new Uint8Array(3)]));
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.bytes()).toEqual({ video: video.appended[0]!.size, audio: audio.appended[0]!.size });
  });
});

describe("TakeRecorder fault mapping", () => {
  it("maps a writer append rejection to onFault('disk-error', ...) exactly once across repeated failures", async () => {
    const onFault = vi.fn();
    const { recorder, videoRecorder, video } = buildRecorder({ onFault });
    recorder.start();
    video.setFailAppend(new Error("disk full"));

    videoRecorder.emitData(new Blob([new Uint8Array(1)]));
    await Promise.resolve();
    await Promise.resolve();
    videoRecorder.emitData(new Blob([new Uint8Array(1)]));
    await Promise.resolve();
    await Promise.resolve();

    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("disk-error", expect.stringContaining("disk full"));
  });

  it("maps MediaRecorder onerror to onFault('encoder-error', ...)", () => {
    const onFault = vi.fn();
    const { recorder, videoRecorder } = buildRecorder({ onFault });
    recorder.start();

    videoRecorder.emitError(new Error("encoder blew up"));

    expect(onFault).toHaveBeenCalledWith("encoder-error", expect.stringContaining("encoder blew up"));
  });

  it("does not stop the recording when a fault occurs", async () => {
    const onFault = vi.fn();
    const { recorder, videoRecorder, video } = buildRecorder({ onFault });
    recorder.start();
    video.setFailAppend(new Error("disk full"));
    videoRecorder.emitData(new Blob([new Uint8Array(1)]));
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.state).toBe("rolling");
  });
});

describe("TakeRecorder.stop", () => {
  it("throws if called when not rolling", async () => {
    const { recorder } = buildRecorder({});
    await expect(recorder.stop()).rejects.toThrow();
  });

  it("awaits both onstop and both finish(), and returns both sidecar arrays", async () => {
    const { recorder, video, audio } = buildRecorder({});
    recorder.start();

    const result = await recorder.stop();

    expect(result.video).toEqual(video.sidecar);
    expect(result.audio).toEqual(audio.sidecar);
    expect(recorder.state).toBe("stopped");
  });

  it("a final dataavailable delivered between stop() and onstop still lands in the sidecar (appended before finish)", async () => {
    const { recorder, videoRecorder, video } = buildRecorder({});
    recorder.start();

    const finalBlob = new Blob([new Uint8Array(7)]);
    videoRecorder.queueFinalBlob(finalBlob); // fake's stop() fires this dataavailable, then onstop

    await recorder.stop();

    expect(video.appended).toEqual([finalBlob]);
  });

  it("propagates a finish() rejection and maps it to onFault('disk-error', ...)", async () => {
    const onFault = vi.fn();
    const { recorder, audio } = buildRecorder({ onFault });
    recorder.start();
    audio.setFailFinish(new Error("disk full at finish"));

    await expect(recorder.stop()).rejects.toThrow("disk full at finish");
    expect(onFault).toHaveBeenCalledWith("disk-error", expect.stringContaining("disk full at finish"));
  });
});

// ---------------------------------------------------------------------------
// A recorder killed mid-take by a fatal encoder error is already inactive: its
// onstop will never fire again, and stopping it can throw. Neither may be
// allowed to cost the take its product files — the healthy stream's final part
// and BOTH sidecars, which 5C needs to develop the take at all.
// ---------------------------------------------------------------------------
describe("TakeRecorder.stop after a fatal encoder error", () => {
  /** Fails the test if any promise rejects with nobody watching. */
  function watchUnhandled() {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    return {
      seen,
      async assertNone(): Promise<void> {
        // Node reports an unhandled rejection only once the microtask queue
        // has drained and the macrotask turn ends.
        await new Promise((r) => setTimeout(r, 10));
        process.off("unhandledRejection", onUnhandled);
        expect(seen).toEqual([]);
      },
    };
  }

  it("stop() still resolves, returns BOTH sidecars, and never calls stop() on the dead recorder", async () => {
    const watch = watchUnhandled();
    const onFault = vi.fn();
    const { recorder, videoRecorder, audioRecorder, video, audio } = buildRecorder({ onFault });
    recorder.start();

    // Both streams have committed parts…
    videoRecorder.emitData(new Blob([new Uint8Array(4)]));
    audioRecorder.emitData(new Blob([new Uint8Array(2)]));
    await Promise.resolve();
    await Promise.resolve();

    // …then the video encoder dies fatally, mid-take.
    videoRecorder.emitError(new Error("encoder blew up"));
    expect(onFault).toHaveBeenCalledWith("encoder-error", expect.stringContaining("encoder blew up"));
    expect(recorder.state).toBe("rolling"); // a fault never stops the recording

    // The audio stream keeps writing right up to the cut.
    const audioFinal = new Blob([new Uint8Array(9)]);
    audioRecorder.queueFinalBlob(audioFinal);

    const result = await recorder.stop();

    // The dead recorder was left alone — not even asked to stop, so there is
    // no InvalidStateError to swallow in the first place.
    expect(videoRecorder.stopAttempts).toBe(0);
    expect(videoRecorder.stopCalled).toBe(false);
    expect(audioRecorder.stopCalled).toBe(true);
    // BOTH sidecars survive — the dead stream's committed parts get one too.
    expect(result.video).toEqual(video.sidecar);
    expect(result.audio).toEqual(audio.sidecar);
    // The healthy stream is complete: its final flushed blob landed before finish().
    expect(audio.appended[audio.appended.length - 1]).toBe(audioFinal);
    expect(recorder.state).toBe("stopped");

    await watch.assertNone();
  });

  it("both recorders dead still finishes both writers and resolves", async () => {
    const watch = watchUnhandled();
    const { recorder, videoRecorder, audioRecorder, video, audio } = buildRecorder({});
    recorder.start();
    videoRecorder.emitError(new Error("video encoder blew up"));
    audioRecorder.emitError(new Error("audio encoder blew up"));

    const result = await recorder.stop();

    expect(videoRecorder.stopAttempts).toBe(0);
    expect(audioRecorder.stopAttempts).toBe(0);
    expect(result.video).toEqual(video.sidecar);
    expect(result.audio).toEqual(audio.sidecar);

    await watch.assertNone();
  });

  it("a dead video recorder does not stop the healthy audio writer from being finished, even when the dead stream's finish() fails", async () => {
    const watch = watchUnhandled();
    const onFault = vi.fn();
    const { recorder, videoRecorder, video, audio } = buildRecorder({ onFault });
    recorder.start();
    videoRecorder.emitError(new Error("encoder blew up"));
    video.setFailFinish(new Error("disk full at finish"));

    const finished = vi.spyOn(audio.writer, "finish");
    await expect(recorder.stop()).rejects.toThrow("disk full at finish");
    // The failure is reported, but the healthy stream was still finished —
    // its sidecar exists on disk even though the caller sees the rejection.
    expect(finished).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("disk-error", expect.stringContaining("disk full at finish"));

    await watch.assertNone();
  });

  it("BOTH finish() rejections surface as one rejection, with no unhandled second one", async () => {
    const watch = watchUnhandled();
    const { recorder, video, audio } = buildRecorder({});
    recorder.start();
    video.setFailFinish(new Error("video finish failed"));
    audio.setFailFinish(new Error("audio finish failed"));

    await expect(recorder.stop()).rejects.toThrow("video finish failed");

    await watch.assertNone();
  });
});
