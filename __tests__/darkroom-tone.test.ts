// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  TONE_FREQS,
  BEEP_MS,
  BEEP_GAP_MS,
  MARK_TOTAL_MS,
  RAMP_S,
  SAMPLE_RATE,
  synthesizeMark,
  findMarks,
  findMarksWindowed,
  SEARCH_WINDOW_S,
} from "../scripts/darkroom/tone.mjs";

const ECHO_MINUS_8DB = Math.pow(10, -8 / 20); // ~0.3981

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

/**
 * Builds the physically-correct mark INDEPENDENTLY of `synthesizeMark()` —
 * per-beep carrier phase relative to that beep's own start, matching how a
 * real Web Audio `OscillatorNode` behaves (`osc.start(start)` gives phase 0
 * at `start`, not at the AudioContext's t=0). This exists so a regression in
 * `synthesizeMark()`'s own phase math can't hide by construction (a bug in
 * the module under test can't "self-verify" against a fixture built by that
 * same buggy code).
 */
function buildTrueMark(): Float32Array {
  const beepS = BEEP_MS / 1000;
  const gapS = BEEP_GAP_MS / 1000;
  const length = Math.round((MARK_TOTAL_MS / 1000) * SAMPLE_RATE);
  const beeps = [
    { start: 0, stop: beepS },
    { start: beepS + gapS, stop: 2 * beepS + gapS },
  ];
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    let sample = 0;
    for (const { start, stop } of beeps) {
      if (t < start || t > stop) continue;
      let env: number;
      if (t < start + RAMP_S) env = (0.5 * (t - start)) / RAMP_S;
      else if (t > stop - RAMP_S) env = (0.5 * (stop - t)) / RAMP_S;
      else env = 0.5;
      let carrier = 0;
      for (const freq of TONE_FREQS) carrier += Math.sin(2 * Math.PI * freq * (t - start));
      sample += env * carrier;
    }
    out[i] = sample;
  }
  return out;
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

describe("darkroom tone: review-round regressions", () => {
  it("(CRITICAL 1 regression) beep-2 carrier phase is per-beep, not absolute-mark-time", () => {
    // Built independently of synthesizeMark() — see buildTrueMark() above.
    // If synthesizeMark()'s internal template uses the wrong phase for beep
    // 2, the matched-filter refine correlates against a mismatched shape
    // and can lock onto a side lobe instead of the true onset. A genuine
    // end mark at 5.0s (via the module's own synthesizeMark()) keeps this a
    // normal findMarks() call rather than a start-only probe.
    const trueMark = buildTrueMark();
    const pcm = new Float32Array(Math.round(6 * SAMPLE_RATE));
    addNoise(pcm, 0.02, 3141592);
    const at = Math.round(2.0 * SAMPLE_RATE);
    for (let i = 0; i < trueMark.length; i++) pcm[at + i] += trueMark[i];
    const endMark = synthesizeMark();
    const endAt = Math.round(5.0 * SAMPLE_RATE);
    for (let i = 0; i < endMark.length; i++) pcm[endAt + i] += endMark[i];

    const { start } = findMarks(pcm);
    expect(Math.abs(start - at)).toBeLessThanOrEqual(1);
  });

  it("(IMPORTANT 3 regression) non-adjacent valid pair survives a closer same-band echo", () => {
    // Real mark's two beeps at 1.000s / 1.300s, plus a -8dB echo of EACH
    // beep 150ms later (1.150s / 1.450s). Onsets land at [0, 150, 300, 450]
    // (ms, relative) — the true pair (0, 300) is NOT adjacent in that list,
    // so an adjacent-only pairing check would skip it (and fail on 150/450
    // spacing) and misreport tone-start-missing. A genuine end mark at 8.0s
    // (well clear of the start cluster and its minOnset exclusion) keeps
    // this a normal findMarks() call rather than a start-only probe.
    const pcm = new Float32Array(Math.round(10 * SAMPLE_RATE));
    addNoise(pcm, 0.02, 271828);
    const mark = synthesizeMark();
    const beepLen = Math.round((BEEP_MS / 1000) * SAMPLE_RATE);
    const beep2Offset = Math.round(((BEEP_MS + BEEP_GAP_MS) / 1000) * SAMPLE_RATE);
    const beep1 = mark.subarray(0, beepLen);
    const beep2 = mark.subarray(beep2Offset, beep2Offset + beepLen);

    const at = Math.round(1.0 * SAMPLE_RATE);
    const echoDelay = Math.round(0.15 * SAMPLE_RATE);
    for (let i = 0; i < beepLen; i++) {
      pcm[at + i] += beep1[i];
      pcm[at + beep2Offset + i] += beep2[i];
      pcm[at + echoDelay + i] += beep1[i] * ECHO_MINUS_8DB;
      pcm[at + beep2Offset + echoDelay + i] += beep2[i] * ECHO_MINUS_8DB;
    }
    const endAt = Math.round(8.0 * SAMPLE_RATE);
    for (let i = 0; i < mark.length; i++) pcm[endAt + i] += mark[i];

    const { start } = findMarks(pcm);
    expect(Math.abs(start - at)).toBeLessThanOrEqual(1);
    // Known limit (ledgered, not fixed this round): an echo close enough
    // that its beep merges into the same Goertzel frame run as the real
    // beep (roughly <= the 120ms frame width, e.g. an 80ms echo) is not
    // distinguishable as a separate onset by the coarse grouping stage.
  });

  it("(CRITICAL 2 regression) 'first valid match wins' applies to BOTH windows — echo must not win the end mark", () => {
    // True marks at 1.0s and 58.0s in a 60s track, each with a -8dB copy of
    // the WHOLE mark 500ms later (an acoustic re-capture bleeding back in).
    // The end mark must resolve to the genuine (earlier) occurrence in its
    // window, not the later echo — "first" must be used for the end window
    // too, just like the start window.
    const pcm = new Float32Array(Math.round(60 * SAMPLE_RATE));
    addNoise(pcm, 0.02, 999983);
    const mark = synthesizeMark();
    const echoDelay = Math.round(0.5 * SAMPLE_RATE);

    const trueStart = Math.round(1.0 * SAMPLE_RATE);
    const trueEnd = Math.round(58.0 * SAMPLE_RATE);
    for (const at of [trueStart, trueEnd]) {
      for (let i = 0; i < mark.length; i++) {
        pcm[at + i] += mark[i];
        if (at + echoDelay + i < pcm.length) pcm[at + echoDelay + i] += mark[i] * ECHO_MINUS_8DB;
      }
    }

    const { start, end } = findMarks(pcm);
    expect(Math.abs(start - trueStart)).toBeLessThanOrEqual(1);
    expect(Math.abs(end - trueEnd)).toBeLessThanOrEqual(1);
  });

  it("(IMPORTANT 4) survives worst-case frame-grid misalignment (non-10ms-aligned onset)", () => {
    // Every other fixture's mark sits on the 10ms Goertzel hop grid. This
    // one deliberately doesn't (2.000s + 237 samples), to exercise the
    // coarse stage's overlap-fraction margin at an arbitrary phase. A
    // genuine (grid-aligned) end mark at 5.0s keeps this a normal
    // findMarks() call rather than a start-only probe.
    const track = buildTrack(6, []);
    const mark = synthesizeMark();
    const at = Math.round(2.0 * SAMPLE_RATE) + 237;
    for (let i = 0; i < mark.length; i++) track[at + i] += mark[i];
    const endAt = Math.round(5.0 * SAMPLE_RATE);
    for (let i = 0; i < mark.length; i++) track[endAt + i] += mark[i];

    const { start } = findMarks(track);
    expect(start - at).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findMarksWindowed — the window-limited entry (5C punch list). Must agree
// with findMarks exactly: same marks, same absolute sample indices, whether
// fed the decode's windowed form or its short-take {full} fallback.
// ---------------------------------------------------------------------------
describe("darkroom tone: findMarksWindowed", () => {
  it("windowed form of a long track yields the same absolute marks as findMarks on the whole track", () => {
    const track = buildTrack(50, [2.0, 48.5]);
    const whole = findMarks(track);

    const W = SEARCH_WINDOW_S * SAMPLE_RATE;
    const tailStart = track.length - W;
    const windowed = findMarksWindowed({
      head: track.slice(0, W),
      tail: track.slice(tailStart),
      tailStart,
      totalSamples: track.length,
    });
    expect(windowed).toEqual(whole);
  });

  it("{full} fallback delegates to findMarks — short-take overlap semantics preserved verbatim", () => {
    const track = buildTrack(10, [2.0, 8.5]);
    expect(findMarksWindowed({ full: track })).toEqual(findMarks(track));
  });

  it("missing end mark in the tail window still throws tone-end-missing", () => {
    const track = buildTrack(50, [2.0]); // no end mark anywhere
    const W = SEARCH_WINDOW_S * SAMPLE_RATE;
    const tailStart = track.length - W;
    expect(() =>
      findMarksWindowed({ head: track.slice(0, W), tail: track.slice(tailStart), tailStart, totalSamples: track.length }),
    ).toThrowError(expect.objectContaining({ code: "tone-end-missing" }));
  });
});

describe("darkroom tone: conversation-level background noise (take-20260804-0106-4f4c regression)", () => {
  // The real 8/3 take with the professor: both end-mark beeps on tape at
  // full energy and relatively quiet DURING the beeps, but loud speech/room
  // audio immediately AROUND them (they were mid-conversation at roll-stop).
  // An analysis frame equal to the 120ms beep has at most one hop fully
  // inside the beep — and only if the decode's sample grid happens to align;
  // every other hop straddles a beep edge, drags adjacent speech into its
  // floor, and fails the 6x band test. The pipeline's own tail decode found
  // beep 1 and missed beep 2 entirely -> tone-one-beep, while a probe decode
  // of the same file at a different -ss found both. Detection must not hinge
  // on decode alignment: sweep the mark placement across the full 10ms hop
  // grid and require both marks found at every alignment.
  it("finds both marks at every sub-hop alignment with speech hard against the beep edges", () => {
    const mark = synthesizeMark();
    const beepLen = Math.round((BEEP_MS / 1000) * SAMPLE_RATE);
    const gapLen = Math.round((BEEP_GAP_MS / 1000) * SAMPLE_RATE);
    const burstAmp = 1.0; // "speech": loud broadband, right up to the beep boundary
    const burstLen = Math.round(0.5 * SAMPLE_RATE);
    for (let shiftMs = 0; shiftMs < 10; shiftMs += 1) {
      const shiftS = shiftMs / 1000;
      const startS = 0.6 + shiftS;
      const endS = 39.0 + shiftS;
      const pcm = new Float32Array(Math.round(41 * SAMPLE_RATE));
      addNoise(pcm, 0.1, NOISE_SEED + shiftMs); // quiet baseline everywhere, beeps included
      const burst = (from: number, len: number) => {
        const next = makeLcg(NOISE_SEED ^ from);
        for (let i = 0; i < len && from + i < pcm.length; i++) pcm[from + i] += (next() * 2 - 1) * burstAmp;
      };
      for (const markS of [startS, endS]) {
        const at = Math.round(markS * SAMPLE_RATE);
        for (let i = 0; i < mark.length && at + i < pcm.length; i++) pcm[at + i] += mark[i];
        burst(at - burstLen, burstLen); // speech ending exactly at beep 1's onset
        burst(at + beepLen, gapLen); // speech filling the 180ms inter-beep gap
        burst(at + mark.length, burstLen); // speech resuming exactly at beep 2's end
      }
      const marks = findMarks(pcm);
      expect(Math.abs(marks.start - Math.round(startS * SAMPLE_RATE))).toBeLessThanOrEqual(96); // ±2ms
      expect(Math.abs(marks.end - Math.round(endS * SAMPLE_RATE))).toBeLessThanOrEqual(96);
    }
  }, 60000);
});
