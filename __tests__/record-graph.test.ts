import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessedAudioError, buildRecordGraph } from "@/lib/podcast/recordGraph";

function fakes(settings: Partial<MediaTrackSettings> = {}) {
  const rawTrack = {
    stop: vi.fn(),
    getSettings: () => ({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...settings }),
  };
  const destTrack = { id: "dest" };
  const ctxOpts: AudioContextOptions[] = [];
  // Every gain node scheduleToneMark() creates is captured here so a test can
  // inspect exactly which nodes each beep's gain was connected to.
  const gains: { gain: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn> }[] = [];
  const ctx = {
    close: vi.fn(),
    currentTime: 1,
    destination: {},
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getAudioTracks: () => [destTrack] } })),
    createGain: vi.fn(() => {
      const g = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() };
      gains.push(g);
      return g;
    }),
    createOscillator: vi.fn(() => ({ frequency: {}, connect: vi.fn(), start: vi.fn(), stop: vi.fn() })),
  };
  const stream = { getAudioTracks: () => [rawTrack] } as unknown as MediaStream;
  const gum = vi.fn(async () => stream);
  const deps = {
    getUserMedia: gum,
    AudioContextCtor: vi.fn(function (this: unknown, o?: AudioContextOptions) { ctxOpts.push(o!); return ctx; }) as never,
  };
  return { deps, gum, rawTrack, destTrack, ctx, ctxOpts, stream, gains };
}

describe("record graph", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests a raw mono capture of the chosen device at 48 kHz", async () => {
    const { deps, gum, ctxOpts, destTrack, rawTrack, ctx, stream } = fakes();
    const graph = await buildRecordGraph("mic-1", deps);
    expect(gum).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-1" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    expect(ctxOpts[0]).toEqual({ sampleRate: 48000 });
    expect(graph.recordedTrack).toBe(destTrack);
    // The raw capture is exposed separately: the destination track never
    // ends or mutes, so only this one can tell the watchdog the mic is gone.
    expect(graph.rawTrack).toBe(rawTrack);
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

  it("playMark() routes the tone into BOTH the recorded destination and speakers, exactly 50ms out", async () => {
    const { deps, ctx, gains } = fakes();
    const graph = await buildRecordGraph(undefined, deps);
    const destNode = ctx.createMediaStreamDestination.mock.results[0]!.value;

    const startedAt = graph.playMark();

    // Regression guard: every tone-beep gain must fan out to the recorded
    // destination AND ctx.destination — dropping either connect() call would
    // silently pass every other test in this file.
    expect(gains.length).toBeGreaterThan(0);
    for (const gain of gains) {
      expect(gain.connect).toHaveBeenCalledWith(destNode);
      expect(gain.connect).toHaveBeenCalledWith(ctx.destination);
    }

    // Scheduled exactly 50ms (MARK_LEAD_S) out from ctx.currentTime, on the ctx clock.
    const scheduledStart = gains[0]!.gain.setValueAtTime.mock.calls[0]![1];
    expect(scheduledStart).toBeCloseTo(ctx.currentTime + 0.05, 5);

    // Returned wall-clock ms is exactly Date.now() + 50ms (MARK_LEAD_S * 1000)
    // — pinned exactly under the fixed system time, no tolerance window
    // papering over an unmocked, genuinely-variable Date.now().
    expect(startedAt).toBe(NOW + 50);
  });
});
