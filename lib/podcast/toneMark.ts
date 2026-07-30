// The sync mark: a dual-frequency two-beep. Frequencies sit above the
// speech-formant band and are non-harmonic so voice energy can't fake the
// pair; the darkroom (5C) matched-filters against this exact shape, so the
// constants here are the single source of truth.

export const TONE_FREQS = [1833, 2417] as const;
export const BEEP_MS = 120;
export const BEEP_GAP_MS = 180;
export const MARK_TOTAL_MS = 2 * BEEP_MS + BEEP_GAP_MS;
const RAMP_S = 0.005; // click-free edges

export function toneSchedule(atSec: number): { start: number; stop: number }[] {
  const beep = BEEP_MS / 1000;
  return [
    { start: atSec, stop: atSec + beep },
    { start: atSec + beep + BEEP_GAP_MS / 1000, stop: atSec + 2 * beep + BEEP_GAP_MS / 1000 },
  ];
}

/** Schedule the mark into every node in `outs`. Returns mark end (ctx sec). */
export function scheduleToneMark(ctx: BaseAudioContext, outs: AudioNode[], atSec: number): number {
  for (const { start, stop } of toneSchedule(atSec)) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.5, start + RAMP_S);
    gain.gain.setValueAtTime(0.5, stop - RAMP_S);
    gain.gain.linearRampToValueAtTime(0, stop);
    for (const out of outs) gain.connect(out);
    for (const freq of TONE_FREQS) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(start);
      osc.stop(stop + RAMP_S);
    }
  }
  return atSec + MARK_TOTAL_MS / 1000;
}
