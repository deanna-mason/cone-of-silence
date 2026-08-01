// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  TONE_FREQS,
  BEEP_MS,
  SAMPLE_RATE,
  synthesizeMark,
  findMarks,
} from "../scripts/darkroom/tone.mjs";

// Deterministic LCG (never Math.random) — same seed always yields the same
// "pink-ish" noise floor so fixtures are reproducible.
function makeLcg(seed: number) {
  let state = seed >>> 0;
  return function next(): number {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296; // [0, 1)
  };
}

const NOISE_SEED = 424242;

function addNoise(pcm: Float32Array, amplitude: number, seed = NOISE_SEED) {
  const next = makeLcg(seed);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] += (next() * 2 - 1) * amplitude;
  }
}

/** lengthS seconds of deterministic noise with synthesizeMark() summed in
 * at each of `marks` (seconds from track start). */
function buildTrack(lengthS: number, marks: number[]): Float32Array {
  const pcm = new Float32Array(Math.round(lengthS * SAMPLE_RATE));
  addNoise(pcm, 0.02);
  const mark = synthesizeMark();
  for (const markS of marks) {
    const at = Math.round(markS * SAMPLE_RATE);
    for (let i = 0; i < mark.length && at + i < pcm.length; i++) {
      pcm[at + i] += mark[i];
    }
  }
  return pcm;
}

describe("darkroom tone: synthesizeMark", () => {
  it("constants match lib/podcast/toneMark.ts exactly", async () => {
    const web = await import("../lib/podcast/toneMark");
    const dark = await import("../scripts/darkroom/tone.mjs");
    expect([dark.TONE_FREQS, dark.BEEP_MS, dark.BEEP_GAP_MS, dark.MARK_TOTAL_MS]).toEqual([
      [...web.TONE_FREQS],
      web.BEEP_MS,
      web.BEEP_GAP_MS,
      web.MARK_TOTAL_MS,
    ]);
  });

  it("produces exactly MARK_TOTAL_MS/1000 * SAMPLE_RATE samples", () => {
    const mark = synthesizeMark();
    expect(mark.length).toBe(20160);
  });

  it("is silent in the gap between the two beeps", () => {
    const mark = synthesizeMark();
    const beepLen = Math.round((BEEP_MS / 1000) * SAMPLE_RATE);
    // Middle of the 180ms gap: well clear of both ramps.
    const gapMid = beepLen + Math.round(0.09 * SAMPLE_RATE);
    expect(mark[gapMid]).toBe(0);
  });
});

describe("darkroom tone: findMarks", () => {
  it("locates start+end marks to the exact sample (±1)", () => {
    const track = buildTrack(10, [2.0, 8.5]);
    const { start, end } = findMarks(track);
    expect(Math.abs(start - Math.round(2.0 * SAMPLE_RATE))).toBeLessThanOrEqual(1);
    expect(Math.abs(end - Math.round(8.5 * SAMPLE_RATE))).toBeLessThanOrEqual(1);
  });

  it("start mark at 0.05s (MARK_LEAD_S) is found — window includes t=0", () => {
    const track = buildTrack(5, [0.05, 4.0]);
    const { start } = findMarks(track);
    expect(Math.abs(start - Math.round(0.05 * SAMPLE_RATE))).toBeLessThanOrEqual(1);
  });

  it("one beep only at the start (second beep zeroed) → tone-one-beep", () => {
    const track = buildTrack(5, [1.0]);
    const secondBeepStart = Math.round((1.0 + 0.3) * SAMPLE_RATE);
    const secondBeepEnd = Math.round((1.0 + 0.42) * SAMPLE_RATE);
    track.fill(0, secondBeepStart, secondBeepEnd);

    expect.assertions(1);
    try {
      findMarks(track);
    } catch (err: any) {
      expect(err.code).toBe("tone-one-beep");
    }
  });

  it("no end mark → tone-end-missing", () => {
    // Track long enough that the 20s end-window doesn't overlap the start
    // mark near t=1s.
    const track = buildTrack(25, [1.0]);

    expect.assertions(1);
    try {
      findMarks(track);
    } catch (err: any) {
      expect(err.code).toBe("tone-end-missing");
    }
  });

  it("wrong spacing (beeps 600ms apart) is not a mark → tone-start-missing", () => {
    const track = buildTrack(5, []); // noise only
    const mark = synthesizeMark();
    const beepLen = Math.round((BEEP_MS / 1000) * SAMPLE_RATE);
    const beep = mark.subarray(0, beepLen);

    const pos1 = Math.round(1.0 * SAMPLE_RATE);
    const pos2 = Math.round(1.6 * SAMPLE_RATE); // 600ms after pos1
    for (let i = 0; i < beepLen; i++) {
      track[pos1 + i] += beep[i];
      track[pos2 + i] += beep[i];
    }

    expect.assertions(1);
    try {
      findMarks(track);
    } catch (err: any) {
      expect(err.code).toBe("tone-start-missing");
    }
  });

  it("single-band impostor (1833Hz alone at full amplitude) rejected", () => {
    const track = buildTrack(5, []); // noise only
    const beepLen = Math.round((BEEP_MS / 1000) * SAMPLE_RATE);
    const pos = Math.round(1.0 * SAMPLE_RATE);
    for (let i = 0; i < beepLen; i++) {
      track[pos + i] += Math.sin((2 * Math.PI * TONE_FREQS[0] * i) / SAMPLE_RATE);
    }

    expect.assertions(1);
    try {
      findMarks(track);
    } catch (err: any) {
      expect(err.code).toBe("tone-start-missing");
    }
  });
});
