// The recorded audio path: raw mic + sync tone ONLY (spec §5A invariant —
// the klaxon and all UI sounds must never reach this graph). A second
// getUserMedia of the call's mic; Chrome applies processing per-track, so the
// call's track is unaffected. Headphones mode records with ALL browser DSP
// off. Echo-guard mode (the host declared open speakers) keeps
// echoCancellation ON — it cancels the partner's voice playing from this
// host's speakers, the acoustic bleed that ruined the 8/4 rehearsal take —
// while NS/AGC stay off (the darkroom does its own noise/loudness work).
// Both modes fail closed when the track's settings don't match the request.
import { scheduleToneMark } from "./toneMark";

export class ProcessedAudioError extends Error {
  constructor() { super("microphone capture came back with browser processing enabled"); }
}

export class EchoGuardUnavailableError extends Error {
  constructor() { super("echo cancellation could not be enabled for open-speakers recording"); }
}

export interface RecordGraphDeps {           // injectable for jsdom tests
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextCtor?: new (o?: AudioContextOptions) => AudioContext;
}

export interface RecordGraph {
  recordedTrack: MediaStreamTrack;           // mic + tone, 48 kHz — feeds BOTH recorders
  /** The raw mic capture behind the graph. The watchdog polls THIS for mic-lost:
   *  a MediaStreamDestination track never ends or mutes, so `recordedTrack`
   *  stays "live" even after the microphone is unplugged. */
  rawTrack: MediaStreamTrack;
  /** Schedule the mark ~50 ms out on recorded graph AND speakers; returns Date.now() ms of mark start. */
  playMark(): number;
  close(): void;                             // stop raw track, close ctx
}

const MARK_LEAD_S = 0.05;

export async function buildRecordGraph(
  audioDeviceId: string | undefined,
  opts: { echoGuard: boolean },
  deps: RecordGraphDeps = {},
): Promise<RecordGraph> {
  const gum = deps.getUserMedia ?? ((c) => navigator.mediaDevices.getUserMedia(c));
  const Ctx = deps.AudioContextCtor ?? AudioContext;
  const stream = await gum({
    audio: {
      ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
      echoCancellation: opts.echoGuard, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    },
  });
  const raw = stream.getAudioTracks()[0];
  const s = raw.getSettings();
  if (opts.echoGuard) {
    // EC is the whole point here — a track without it would bake speaker
    // bleed into the tape exactly as if no declaration had been made.
    if (!s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
      raw.stop();
      throw new EchoGuardUnavailableError();
    }
  } else if (s.echoCancellation || s.noiseSuppression || s.autoGainControl) {
    raw.stop();
    throw new ProcessedAudioError();
  }
  const ctx = new Ctx({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(stream).connect(dest); // the gUM stream itself — jsdom-safe, no MediaStream ctor
  return {
    recordedTrack: dest.stream.getAudioTracks()[0],
    rawTrack: raw,
    playMark() {
      // Into the recording AND out loud; ~50 ms lead so both land in-schedule.
      scheduleToneMark(ctx, [dest, ctx.destination], ctx.currentTime + MARK_LEAD_S);
      return Date.now() + MARK_LEAD_S * 1000;
    },
    close() { raw.stop(); void ctx.close(); },
  };
}
