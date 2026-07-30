// The fault-alert klaxon: three short sawtooth blasts, output-only.
//
// SPEC INVARIANT (§5A): the alarm must never leak into the recording. This
// module builds its own throwaway AudioContext wired straight to
// ctx.destination (speakers) and must NEVER import recordGraph.ts or touch
// a MediaStreamDestination — doing so would risk the klaxon bleeding into
// the take. Fire-and-forget: schedule the blasts, schedule the ctx close
// for after they finish, and return immediately without awaiting anything.
export interface KlaxonDeps {
  AudioContextCtor?: new (o?: AudioContextOptions) => AudioContext;
}

const BLAST_S = 0.15;
const BLAST_COUNT = 3;
const SWEEP_FROM_HZ = 440;
const SWEEP_TO_HZ = 880;
const GAIN = 0.4;

export function soundKlaxon(deps: KlaxonDeps = {}): void {
  const Ctx = deps.AudioContextCtor ?? AudioContext;
  const ctx = new Ctx();

  const gain = ctx.createGain();
  gain.gain.value = GAIN;
  gain.connect(ctx.destination);

  let t = ctx.currentTime;
  for (let i = 0; i < BLAST_COUNT; i++) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(SWEEP_FROM_HZ, t);
    osc.frequency.linearRampToValueAtTime(SWEEP_TO_HZ, t + BLAST_S);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + BLAST_S);
    t += BLAST_S;
  }

  // Schedule the close for after the last blast ends — closing immediately
  // would risk cutting the scheduled audio off. Don't await the promise;
  // this function is fire-and-forget.
  setTimeout(() => {
    void ctx.close();
  }, BLAST_COUNT * BLAST_S * 1000);
}
