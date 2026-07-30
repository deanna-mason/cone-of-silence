import { describe, expect, it, vi } from "vitest";
import { ProcessedAudioError, buildRecordGraph } from "@/lib/podcast/recordGraph";

function fakes(settings: Partial<MediaTrackSettings> = {}) {
  const rawTrack = {
    stop: vi.fn(),
    getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...settings }),
  };
  const destTrack = { id: "dest" };
  const ctxOpts: AudioContextOptions[] = [];
  const ctx = {
    close: vi.fn(),
    currentTime: 1,
    destination: {},
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getAudioTracks: () => [destTrack] } })),
    createGain: vi.fn(() => ({ gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() })),
    createOscillator: vi.fn(() => ({ frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })),
  };
  const stream = { getAudioTracks: () => [rawTrack] } as unknown as MediaStream;
  const gum = vi.fn(async () => stream);
  const deps = {
    getUserMedia: gum,
    AudioContextCtor: vi.fn(function (this: unknown, o?: AudioContextOptions) { ctxOpts.push(o!); return ctx; }) as never,
  };
  return { deps, gum, rawTrack, destTrack, ctx, ctxOpts, stream };
}

describe("record graph", () => {
  it("requests a raw mono capture of the chosen device at 48 kHz", async () => {
    const { deps, gum, ctxOpts, destTrack, ctx, stream } = fakes();
    const graph = await buildRecordGraph("mic-1", deps);
    expect(gum).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-1" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    expect(ctxOpts[0]).toEqual({ sampleRate: 48000 });
    expect(graph.recordedTrack).toBe(destTrack);
    // jsdom has no MediaStream constructor — the source must be built from the
    // original gUM stream, never a `new MediaStream(...)` wrapper.
    expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(stream);
  });

  it("fails closed when the track comes back processed", async () => {
    const { deps, rawTrack } = fakes({ echoCancellation: true });
    await expect(buildRecordGraph(undefined, deps)).rejects.toBeInstanceOf(ProcessedAudioError);
    expect(rawTrack.stop).toHaveBeenCalled();
  });

  it("close() releases mic and context", async () => {
    const { deps, rawTrack, ctx } = fakes();
    const graph = await buildRecordGraph(undefined, deps);
    graph.close();
    expect(rawTrack.stop).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
  });
});
