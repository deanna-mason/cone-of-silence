import { describe, expect, it, vi } from "vitest";
import { BEEP_GAP_MS, BEEP_MS, MARK_TOTAL_MS, TONE_FREQS, scheduleToneMark, toneSchedule } from "@/lib/podcast/toneMark";

function fakeCtx() {
  const oscs: { freq: number; started: number; stopped: number }[] = [];
  const ctx = {
    currentTime: 0,
    createOscillator: () => {
      const rec = { freq: 0, started: -1, stopped: -1 };
      oscs.push(rec);
      return {
        frequency: { set value(v: number) { rec.freq = v; } },
        connect: vi.fn(),
        start: (t: number) => { rec.started = t; },
        stop: (t: number) => { rec.stopped = t; },
      };
    },
    createGain: () => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
  } as unknown as BaseAudioContext;
  return { ctx, oscs };
}

describe("tone mark", () => {
  it("schedules two beeps with the documented spacing", () => {
    const [a, b] = toneSchedule(10);
    expect(a.start).toBe(10);
    expect(a.stop).toBeCloseTo(10 + BEEP_MS / 1000);
    expect(b.start).toBeCloseTo(10 + (BEEP_MS + BEEP_GAP_MS) / 1000);
    expect(MARK_TOTAL_MS).toBe(420);
  });

  it("creates an oscillator per freq per beep and returns the end time", () => {
    const { ctx, oscs } = fakeCtx();
    const end = scheduleToneMark(ctx, [], 5);
    expect(oscs).toHaveLength(TONE_FREQS.length * 2);
    expect(new Set(oscs.map((o) => o.freq))).toEqual(new Set(TONE_FREQS));
    expect(end).toBeCloseTo(5 + MARK_TOTAL_MS / 1000);
    expect(oscs.every((o) => o.started >= 5 && o.stopped <= end + 0.01)).toBe(true);
  });
});
