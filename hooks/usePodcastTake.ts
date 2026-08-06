// hooks/usePodcastTake.ts
// Podcast mode, assembled. Everything under lib/podcast/ is a single-purpose
// part; this hook is the only place they meet:
//
//   vault        — where the tape is written (folder handle + permission)
//   recordGraph  — the raw mic + tone capture that feeds the recorders
//   recorder     — two MediaRecorders streaming into PartWriters
//   takeProtocol — the roll/stop handshake with the other agent
//   watchdog     — the 1 Hz health check + beacon exchange
//   klaxon       — the alarm, speakers only, never the tape
//
// Its output is the PodcastPanelState the room page renders, so all of the
// sequencing lives here and the panel stays a pure function of props.
"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PodcastPanelState } from "@/components/PodcastPanel";
import type { CallBus } from "@/hooks/useCallSession";
import { getSessionSnapshot } from "@/lib/authApi";
import { soundKlaxon } from "@/lib/podcast/klaxon";
import { buildRecordGraph, type RecordGraph } from "@/lib/podcast/recordGraph";
import { TakeRecorder, type RecorderFault } from "@/lib/podcast/recorder";
import { COUNTDOWN_MS, TakeCoordinator } from "@/lib/podcast/takeProtocol";
import {
  chooseVault as chooseVaultFolder,
  openTakeDir,
  PartWriter,
  requestVaultAccess,
  vaultPermission,
  type VaultPermission,
} from "@/lib/podcast/vault";
import {
  BEACON_INTERVAL_MS,
  evaluate,
  localBeacon,
  type Beacon,
  type Fault,
  type WatchSnapshot,
} from "@/lib/podcast/watchdog";

const VP8 = "video/webm;codecs=vp8,opus";

/** localStorage key for the most recent take with tape on disk — zero PII,
 *  just an id and a timestamp. Survives reload so the operator (and 5C) can
 *  find the take that was rolling when the page went away. */
export const LAST_TAKE_KEY = "cos-last-take";

function readLastTakeId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_TAKE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { takeId?: unknown };
    return typeof parsed.takeId === "string" ? parsed.takeId : null;
  } catch {
    return null;
  }
}

function writeLastTakeId(takeId: string): void {
  try {
    localStorage.setItem(LAST_TAKE_KEY, JSON.stringify({ takeId, at: Date.now() }));
  } catch {
    // best-effort — a failed write only costs the reload-recovery convenience
  }
}

// ---------------------------------------------------------------------
// Client-only mount reads (auth session + the stored last-take id), sourced
// from useSyncExternalStore instead of a mount effect. Both are localStorage
// reads, so the SERVER snapshot is null and React resyncs to the real value
// right after hydration — the same "blank on the server, real on the client"
// contract the old effect had. Neither store has a native change event: the
// no-op subscribe preserves the old "read once, then follow React's own
// render schedule" behavior (same idiom as app/account and app/studio).
// Both snapshots are primitives (string | null), so they are referentially
// stable by value; the session read goes through authApi's cached
// getSessionSnapshot rather than getSession (which re-parses per call).
// ---------------------------------------------------------------------
function noopSubscribe(): () => void {
  return () => {};
}

function getUsernameSnapshot(): string | null {
  return getSessionSnapshot()?.username ?? null;
}

function getNullServerSnapshot(): null {
  return null;
}

/**
 * How long after OUR recorders start a partner beacon of "not rolling yet" is
 * ignored.
 *
 * Both sides start at the same scheduled instant, but each side's start is an
 * async chain (a second getUserMedia, a directory open) that can take a few
 * hundred milliseconds more on one machine than the other. During that gap
 * the slower side is still beaconing `rolling: false`, which watchdog row 5
 * reads as partner-fault. The window closes at the partner's first
 * `rolling: true` or after this long, whichever comes first, so a partner who
 * genuinely never gets rolling is still caught — within the 3 s alarm budget.
 *
 * Narrowly scoped on purpose (see isStartupLag): ONLY a quiet not-yet-rolling
 * beacon is suppressed. A partner beacon that carries a fault alarms
 * immediately, however early in the take it arrives.
 */
const PARTNER_GRACE_MS = 1_200;

/** Take phases. `failed` = the wire take is alive but OUR recorders are not. */
type Phase = "idle" | "countdown" | "rolling" | "stopping" | "failed";

export interface PodcastTake {
  panel: PodcastPanelState;
  partnerCodename: string | null;
  /** This host's OWN codename — the same value announced via pod/hello.
   *  Task 11's episode exchange needs it to identify the SENDER on the
   *  wire (an offer's `from` must be the sender's own identity, not the
   *  partner's — CONTROLLER RULING D8). Null until the auth session
   *  store yields a value (a useSyncExternalStore read, ~195). */
  myCodename: string | null;
  /** This side's recorder byte counts, video and audio counted separately —
   *  an aggregate total can't tell "both streams growing" apart from "one
   *  stalled while the other grows"; this is the room page's debug mirror's
   *  source for exactly that per-stream signal (e2e/phase5a-e2e.js). */
  bytes: { video: number; audio: number };
  /** Most recent take with tape on disk; survives reload (localStorage,
   *  LAST_TAKE_KEY). Null until the first take on this browser completes a
   *  stop. */
  lastTakeId: string | null;
  /** A fault has been raised at some point during the take now in progress —
   *  latched, NOT a mirror of `panel.kind === "fault"`. The banner only
   *  stands until the operator acknowledges it; the compromise lasts the whole
   *  take, and so does the room page's need to let them swap a device to fix
   *  it (8/5 re-drill finding 2: acknowledging the unplugged-camera alarm
   *  re-locked the device bar). Cleared when the NEXT take begins; only
   *  meaningful while one is in progress. */
  faultedThisTake: boolean;
  actions: {
    chooseVault(): Promise<void>;
    grantVault(): Promise<void>;
    roll(): void;
    stop(): void;
    dismissFault(): void;
  };
}

export interface PodcastTakeArgs {
  /** logged-in && in-room — false means the hook holds no resources at all. */
  enabled: boolean;
  bus: CallBus;
  /** Data channel availability. The hello announcement rides its rising edge:
   *  the bus underneath drops sends on a closed link instead of queueing. */
  dcOpen: boolean;
  /** The remote roster. Identity, not just headcount — a codename belongs to
   *  the peer that claimed it and must not outlive them. */
  peerIds: string[];
  /** The CALL's video track, as it stands right now. Whichever one is here at
   *  roll time is the one the recorder is handed and encodes for the whole
   *  take; a later swap does NOT re-wire it (see recordedVideoTrackRef). */
  videoTrack: MediaStreamTrack | null;
  /** The mic the capture is ACTUALLY on (useLocalMedia.liveDeviceIds), not the
   *  stored choice: this becomes an `exact` deviceId constraint on the tape's
   *  own mic capture, so a stale pick would silently record the wrong input.
   *  Undefined is the honest "cannot say" — recordGraph omits the constraint
   *  and takes the default. */
  audioDeviceId: string | undefined;
  /** A transfer is in flight — no take may start (decision 8). Gates both
   *  the coordinator's acceptance of an inbound proposal and this hook's own
   *  roll() action. */
  holdRolls: boolean;
}

/**
 * Chrome-on-desktop only: the tape needs a directory handle (File System
 * Access) and a MediaRecorder that can actually produce the container. Never
 * runs during SSR — the guard returns false on the server, and the panel is
 * only mounted after the page's auth effect has run on the client.
 */
function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.showDirectoryPicker === "function" &&
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported?.(VP8) === true
  );
}

// The remote cause is part of the identity: a partner whose camera dropped and
// then whose disk failed is a NEW fault set, and a Stand Down on the first must
// not swallow the second.
function faultKey(faults: Fault[]): string {
  return faults
    .map((f) => `${f.side}:${f.cause}:${f.detail ?? ""}`)
    .sort()
    .join("|");
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function usePodcastTake(args: PodcastTakeArgs): PodcastTake {
  const { enabled, bus, dcOpen, peerIds, videoTrack, audioDeviceId, holdRolls } = args;
  const peerCount = peerIds.length;
  const peerKey = peerIds.join("|");

  const [supported] = useState(detectSupport);
  // Auth + last-take probes: SSR-safe client-only reads (see the snapshot
  // helpers above). The vault probe is async and stays an effect below.
  const username = useSyncExternalStore(noopSubscribe, getUsernameSnapshot, getNullServerSnapshot);
  // readLastTakeId's own try/catch also covers a blocked or corrupt store.
  const storedLastTakeId = useSyncExternalStore(
    noopSubscribe,
    readLastTakeId,
    getNullServerSnapshot,
  );
  const [vaultPerm, setVaultPerm] = useState<VaultPermission | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdownS, setCountdownS] = useState(0);
  const [partnerCodename, setPartnerCodename] = useState<string | null>(null);
  const [faults, setFaults] = useState<Fault[]>([]);
  const [startFault, setStartFault] = useState<Fault | null>(null);
  const [dismissedKey, setDismissedKey] = useState("");
  // Latched by the render-time adjustment below, next to visibleFaults — see
  // the PodcastTake field's doc. Reset only where a take BEGINS (beginTake)
  // and where one is torn down with the coordinator, so a Stand Down, a
  // recovered camera, or a clean tick can never take it back down mid-take.
  const [faultedThisTake, setFaultedThisTake] = useState(false);
  const [meter, setMeter] = useState({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
  const [streamBytes, setStreamBytes] = useState({ video: 0, audio: 0 });
  const [coordinatorGen, setCoordinatorGen] = useState(0);
  // The take THIS mount stopped. It outranks the stored read because
  // writeLastTakeId is best-effort: a blocked or full localStorage must cost
  // only the reload-recovery convenience, never the id of a take whose tape
  // this session actually committed.
  const [recordedTakeId, setRecordedTakeId] = useState<string | null>(null);
  const lastTakeId = recordedTakeId ?? storedLastTakeId;

  // Anything the coordinator callbacks or the 1 Hz tick need to read lives in
  // a ref: both run outside React's render pass and must never see a stale
  // closure. `phaseRef` is the authoritative phase; `setPhase` only mirrors it
  // for rendering (see goPhase).
  const latest = useRef({ videoTrack, audioDeviceId });
  // eslint-disable-next-line react-hooks/refs -- the `latest` idiom documented directly above: its readers are the coordinator callbacks and the 1 Hz tick, which run OUTSIDE React's render pass, so this mirror has to be refreshed on every render or those readers see a stale closure
  latest.current = { videoTrack, audioDeviceId };

  // Same idiom as `latest`: the coordinator is built once per (enabled, bus,
  // identity) — see the effect below — so canAcceptRoll has to read the
  // CURRENT holdRolls through a ref rather than close over the value from
  // whichever render constructed it.
  const holdRollsRef = useRef(holdRolls);
  // eslint-disable-next-line react-hooks/refs -- same `latest` idiom, far end of the one-render-lag bridge documented in app/room/page.tsx (its exchangeBusyRef comment): the only reader is canAcceptRoll, which the coordinator calls from a wire callback outside React's render pass
  holdRollsRef.current = holdRolls;

  // Same idiom again: the coordinator's isPeerLive dep (8/5 ghost-pin fix)
  // reads the CURRENT roster from wire callbacks outside the render pass.
  const peerIdsRef = useRef(peerIds);
  // eslint-disable-next-line react-hooks/refs -- same `latest` idiom as holdRollsRef above; the only reader is the coordinator's isPeerLive, called from a wire callback outside React's render pass
  peerIdsRef.current = peerIds;

  const coordinatorRef = useRef<TakeCoordinator | null>(null);
  // Which coordinator instance is installed, as a number — bumped the moment
  // one is constructed, and the hello effect's announce latch keys on it. The
  // coordinatorGen STATE cannot be that key: the coordinator effect can run in
  // the same commit as the hello effect (a first commit with the channel
  // already open), and in that commit the gen bump has not landed yet — the
  // hello effect would announce under the pre-bump number and then again when
  // the bump re-fires it. 0 means "none built yet".
  const coordinatorEpochRef = useRef(0);
  const graphRef = useRef<RecordGraph | null>(null);
  const recorderRef = useRef<TakeRecorder | null>(null);
  // The EXACT video track handed to the recorder at construction — the thing
  // actually being encoded onto the tape, which is not necessarily the track
  // the call is showing. There is no re-wire path (no replaceTrack anywhere in
  // hooks/ or lib/podcast/), so a mid-take device swap ends this track and
  // mints a new live one for the call while the recorder keeps holding the
  // dead one. The watchdog must poll THIS, exactly as it polls graph.rawTrack
  // for the mic rather than the graph's never-ending destination track;
  // polling the call's current track instead let `camera-lost` clear itself
  // after a swap — panel back to "rolling", beacon back to camOk:true — while
  // the tape's video had silently stopped. Cleared wherever a take begins and
  // wherever one is released.
  const recordedVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const recorderFaultRef = useRef<{ cause: RecorderFault; detail: string } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const epochRef = useRef(0); // bumped on every teardown — cancels in-flight starts
  const rollingSinceRef = useRef(0);
  const bytesRef = useRef({ total: 0, lastChangeAt: 0 });
  const remoteRef = useRef<{ at: number; beacon: Beacon | null }>({ at: 0, beacon: null });
  const partnerRolledRef = useRef(false);
  const klaxonArmedRef = useRef(true);
  // Defer-mark-or-fault: latches when onMark fires before the recorder is
  // actually rolling (the gUM/dir start chain — buildRecordGraph AND
  // openTakeDir — hasn't finished yet). startRecorders plays it the instant
  // recorder.start() returns — see the comment there.
  const pendingMarkRef = useRef(false);
  function goPhase(next: Phase): void {
    phaseRef.current = next;
    setPhase(next);
  }

  // ---------------------------------------------------------------------
  // Vault probe (SSR-safe: the support guard is false on the server).
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    vaultPermission()
      .then((p) => {
        if (!cancelled) setVaultPerm(p);
      })
      .catch(() => {
        if (!cancelled) setVaultPerm("unset");
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // ---------------------------------------------------------------------
  // Take lifecycle helpers. All of these are called from coordinator
  // callbacks or async chains, never from render.
  // ---------------------------------------------------------------------

  /** Releases every resource this take holds. Bumping the epoch cancels any
   *  start chain still in flight so it can't install a graph/recorder behind
   *  the teardown's back. */
  function releaseTake(stopRecorder: boolean): void {
    epochRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && stopRecorder && recorder.state === "rolling") {
      // Discarded: the writers' finish() may run to completion, we just
      // don't wait for it or report on it.
      void recorder.stop().catch(() => {});
    }
    // The hook owns the record graph's lifetime — never leave the raw mic
    // capture running once a take is over (spec §5A: the tally light must
    // tell the truth).
    graphRef.current?.close();
    graphRef.current = null;
    recordedVideoTrackRef.current = null;
    recorderFaultRef.current = null;
    pendingMarkRef.current = false;
  }

  function beginTake(): void {
    epochRef.current += 1;
    const now = Date.now();
    rollingSinceRef.current = now;
    bytesRef.current = { total: 0, lastChangeAt: now };
    remoteRef.current = { at: now, beacon: null };
    partnerRolledRef.current = false;
    klaxonArmedRef.current = true;
    recorderFaultRef.current = null;
    recordedVideoTrackRef.current = null;
    pendingMarkRef.current = false;
    setFaults([]);
    setStartFault(null);
    setDismissedKey("");
    setFaultedThisTake(false);
    setMeter({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
    setStreamBytes({ video: 0, audio: 0 });
  }

  function alarm(): void {
    if (!klaxonArmedRef.current) return;
    klaxonArmedRef.current = false;
    soundKlaxon();
  }

  /** The start chain blew up — the wire take lives on, but nothing local is
   *  recording. Hold the banner up until the operator stands it down. */
  function failStart(cause: RecorderFault, err: unknown): void {
    recorderFaultRef.current = { cause, detail: detailOf(err) };
    graphRef.current?.close();
    graphRef.current = null;
    recordedVideoTrackRef.current = null;
    recorderRef.current = null;
    setStartFault({ side: "local", cause });
    goPhase("failed");
    alarm();
  }

  async function startRecorders(takeId: string): Promise<void> {
    const epoch = epochRef.current;
    const stale = () => epochRef.current !== epoch;
    const { videoTrack: track, audioDeviceId: deviceId } = latest.current;

    if (!track) {
      failStart("encoder-error", new Error("no camera track to record"));
      return;
    }

    let graph: RecordGraph;
    try {
      graph = await buildRecordGraph(deviceId);
    } catch (err) {
      // ProcessedAudioError (browser DSP still on) and an outright capture
      // refusal both land here — neither is a disk problem.
      if (stale()) return;
      failStart("encoder-error", err);
      return;
    }
    if (stale()) {
      graph.close();
      return;
    }
    graphRef.current = graph;

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await openTakeDir(takeId);
    } catch (err) {
      if (stale()) return;
      failStart("disk-error", err);
      return;
    }
    if (stale()) return;

    try {
      const recorder = new TakeRecorder({
        videoTrack: track,
        recordedAudioTrack: graph.recordedTrack,
        writers: {
          video: new PartWriter(dir, "video"),
          // The audio sidecar carried a `phones` declaration as provenance
          // until 2026-08-05. It went out with the declaration itself — a
          // self-reported field nobody could act on. PartWriter still takes
          // extra sidecar fields; there are simply none to add today.
          audio: new PartWriter(dir, "audio", 1000),
        },
        onFault: (cause, detail) => {
          // A discarded recorder's writers keep running to completion, so a
          // late disk error can land after the next take has already begun.
          // Without this guard it would plant a ghost fault on a healthy tape
          // — banner, klaxon, and an alarm sent to the partner.
          if (stale()) return;
          recorderFaultRef.current = { cause, detail };
        },
      });
      recorder.start();
      recorderRef.current = recorder;
      // Pin the track the recorder is actually encoding (see the ref's doc).
      // Set only once the recorder is up, so a construction that threw leaves
      // nothing pinned.
      recordedVideoTrackRef.current = track;
    } catch (err) {
      if (stale()) return;
      failStart("encoder-error", err);
      return;
    }

    const now = Date.now();
    rollingSinceRef.current = now;
    bytesRef.current = { total: 0, lastChangeAt: now };
    goPhase("rolling");

    // Defer-mark-or-fault: onMark may have fired before the recorder above
    // was actually rolling (the gUM/dir chain slower than ROLL_LEAD_MS — the
    // common case on real hardware, per the 2026-07-31 dress rehearsal).
    // Playing earlier — once the graph exists but before recorder.start() —
    // would have played into a destination nothing was capturing yet (a
    // silent clip) or, worse, mid-start, capturing a deformed tone shape 5C's
    // matched filter can't reliably anchor. The recorder is rolling by this
    // line, so playing the latched mark now still lands INSIDE the files —
    // just later than startAtMs, by up to the FULL start chain (gUM +
    // IndexedDB handle open + directory create). 5C: the tone-search window
    // must tolerate that whole bound — seconds, not milliseconds.
    if (pendingMarkRef.current) {
      pendingMarkRef.current = false;
      graphRef.current?.playMark();
    }
  }

  async function stopRecorders(takeId: string): Promise<void> {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    let stopError: unknown = null;
    if (recorder && recorder.state === "rolling") {
      try {
        await recorder.stop();
      } catch (err) {
        stopError = err;
      }
    }
    releaseTake(false);
    // Committed parts are real tape whether this stop itself errored or not
    // (decision 11) — recorded on both paths below.
    setRecordedTakeId(takeId);
    writeLastTakeId(takeId);
    if (stopError) {
      // The sidecar/final part didn't land — the operator needs to know the
      // tape may be short before they walk away from it.
      setStartFault({ side: "local", cause: "disk-error" });
      goPhase("failed");
      alarm();
      return;
    }
    setFaults([]);
    setMeter({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
    setStreamBytes({ video: 0, audio: 0 });
    goPhase("idle");
  }

  // ---------------------------------------------------------------------
  // The 1 Hz watchdog tick — runs from the first countdown second through
  // the end of the take (beacons included; the partner has to hear from us
  // before the tape rolls, not only once it does).
  // ---------------------------------------------------------------------
  function tick(): void {
    const now = Date.now();
    const rolling = phaseRef.current === "rolling";

    const recorder = recorderRef.current;
    const counted = recorder ? recorder.bytes() : null;
    const total = counted ? counted.video + counted.audio : bytesRef.current.total;
    if (total !== bytesRef.current.total) bytesRef.current = { total, lastChangeAt: now };
    if (counted) setStreamBytes(counted);

    // Both rows poll the RECORDED source, never the one the call is currently
    // showing: the track the recorder was handed (see recordedVideoTrackRef)
    // and the raw mic behind the graph (a destination track never ends, so
    // recordedTrack would stay "live" past an unplug — recordGraph's own note).
    // A device swap mid-take replaces neither, which is why `camera-lost`
    // rightly PERSISTS for the rest of the take once the recorded track dies.
    const camera = recordedVideoTrackRef.current;
    const mic = graphRef.current?.rawTrack ?? null;

    // The startup race, and nothing else: a quiet "not rolling yet" from a
    // partner whose start chain is a few hundred ms behind ours. A beacon
    // carrying a fault is never suppressed, so a real partner-side failure in
    // the first second still alarms both hosts inside the budget.
    const remote = remoteRef.current;
    const withinGrace =
      rolling && !partnerRolledRef.current && now - rollingSinceRef.current <= PARTNER_GRACE_MS;
    const isStartupLag =
      remote.beacon === null || (remote.beacon.rolling === false && remote.beacon.fault === null);

    const snapshot: WatchSnapshot = {
      now,
      rolling,
      bytes: total,
      lastBytesChangeAt: bytesRef.current.lastChangeAt,
      videoTrack: camera
        ? { readyState: camera.readyState, muted: camera.muted }
        : { readyState: "ended", muted: false },
      audioTrack: mic
        ? { readyState: mic.readyState, muted: mic.muted }
        : { readyState: "ended", muted: false },
      recorderFault: recorderFaultRef.current,
      remote:
        withinGrace && isStartupLag
          ? { lastBeaconAt: now, lastBeacon: null }
          : { lastBeaconAt: remote.at, lastBeacon: remote.beacon },
    };

    const found = evaluate(snapshot);
    if (found.length > 0) {
      alarm();
    } else {
      klaxonArmedRef.current = true;
      setDismissedKey("");
    }
    setFaults(found);

    const beacon = localBeacon(snapshot);
    coordinatorRef.current?.sendBeacon({
      ...beacon,
      // evaluate() only reports a recorder fault while rolling; a start that
      // never got there still has to reach the partner.
      fault: beacon.fault ?? recorderFaultRef.current?.cause ?? null,
    });

    setMeter({
      elapsedS: rolling ? Math.floor((now - rollingSinceRef.current) / 1000) : 0,
      localBytes: total,
      partnerBytes: remoteRef.current.beacon?.bytes ?? 0,
    });
  }

  // The interval outlives every render, so it calls through a ref rather than
  // capturing one render's `tick`.
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });

  const takeActive = phase !== "idle";
  useEffect(() => {
    if (!takeActive) return;
    const id = setInterval(() => tickRef.current(), BEACON_INTERVAL_MS);
    return () => clearInterval(id);
  }, [takeActive]);

  // ---------------------------------------------------------------------
  // Coordinator lifecycle. One per (enabled, bus, identity) — disposing it
  // also tears down whatever take it was driving.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!enabled || !supported || !username) return;
    const coordinator = new TakeCoordinator(bus, username, {
      onPartnerCodename: (name) => setPartnerCodename(name),
      // Still required by TakeCoordinator, and the wire still PARSES an
      // inbound `phones` (a partner on an older build sends it, and rejecting
      // it would drop their whole hello). Nothing surfaces it any more.
      onPartnerPhones: () => {},
      onCountdown: (msLeft) => {
        setCountdownS(Math.round(msLeft / 1000));
        if (phaseRef.current === "idle") {
          beginTake();
          goPhase("countdown");
        }
      },
      onStartRecorders: (takeId) => {
        if (phaseRef.current === "idle") beginTake();
        void startRecorders(takeId);
      },
      onMark: () => {
        // Latch until the recorder is ACTUALLY rolling, not merely until the
        // graph exists: buildRecordGraph resolving fast while openTakeDir is
        // still the slow half of the chain leaves graphRef.current set but
        // nothing capturing yet — playing then either misses the tape
        // entirely or, worse, catches the recorder mid-start and captures a
        // deformed tone shape 5C's matched filter can't reliably anchor.
        if (recorderRef.current?.state === "rolling") {
          graphRef.current?.playMark();
        } else {
          // The gUM/dir start chain is still in flight — latch instead of
          // dropping the mark. startRecorders plays it the instant
          // recorder.start() returns (see the comment there).
          pendingMarkRef.current = true;
        }
      },
      onStopMark: () => {
        graphRef.current?.playMark();
        if (phaseRef.current === "rolling" || phaseRef.current === "countdown") {
          goPhase("stopping");
        }
      },
      onStopRecorders: (takeId) => {
        if (phaseRef.current === "failed") {
          releaseTake(true);
          return;
        }
        void stopRecorders(takeId);
      },
      onAborted: () => {
        // Stopped before the recorders ever got going — nothing to keep.
        releaseTake(true);
        if (phaseRef.current === "failed") return;
        setFaults([]);
        setMeter({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
        setStreamBytes({ video: 0, audio: 0 });
        goPhase("idle");
      },
      onBeacon: (b) => {
        if (b.rolling) partnerRolledRef.current = true;
        remoteRef.current = { at: Date.now(), beacon: b };
      },
    },
    {
      // Roll hold (decision 8): a transfer in flight quiet-ignores an
      // inbound proposal entirely — no ack, no slot claim, no fault. The
      // proposer's own abort-if-unacked unwinds their countdown.
      //
      // Declaration removed 2026-08-05 — this used to also require
      // `phonesRef.current !== null`, which with the declaration gone would
      // be null forever and silently ignore EVERY inbound roll. A transfer
      // in flight is now the only reason to refuse one.
      canAcceptRoll: () => !holdRollsRef.current,
      // Ghost-pin release (8/5): a pinned partner who has left the live
      // roster (server restart re-mints every peerId) must not hold the
      // mid-take pin — see TakeProtocolDeps.isPeerLive.
      isPeerLive: (peerId) => peerIdsRef.current.includes(peerId),
    });
    coordinatorRef.current = coordinator;
    coordinatorEpochRef.current += 1;
    // NOT announced here: at construction the data channel is usually still
    // closed and the bus drops rather than queues. The effect below does it.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate commit-time signal between two effects: the bump is what re-fires the hello effect below via its `coordinatorGen` dep-array entry now that a new coordinator exists, and nothing in render can derive that — the coordinator is constructed here, in this effect
    setCoordinatorGen((n) => n + 1);
    return () => {
      coordinator.dispose();
      coordinatorRef.current = null;
      releaseTake(true);
      phaseRef.current = "idle";
      setPhase("idle");
      setPartnerCodename(null);
      setFaults([]);
      setStartFault(null);
      setFaultedThisTake(false);
    };
    // The callbacks above read every changing value through refs, so the
    // coordinator survives re-renders — rebuilding it mid-take would drop
    // the handshake on the floor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, supported, username, bus]);

  // ---------------------------------------------------------------------
  // The hello announcement. It rides the data channel opening rather than
  // coordinator construction: the bus is a best-effort broadcast that skips
  // a closed or absent link instead of queueing for it, so a hello sent when
  // the coordinator is built (the instant the user enters the room, before
  // any peer exists) is simply lost — leaving both sides nameless and the
  // clock-offset estimate, which only starts once a hello has been RECEIVED,
  // permanently unreachable.
  //
  // Re-announced on every open transition (reconnect, channel rebuild) and on
  // every roster change (a late joiner's own announcement will not be
  // auto-replied to, since our reply latch fired long ago — so we speak
  // first instead).
  // ---------------------------------------------------------------------
  const announcedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dcOpen) {
      announcedKeyRef.current = null; // the next open re-announces
      return;
    }
    // Keyed on the INSTALLED coordinator (see coordinatorEpochRef), not on the
    // coordinatorGen state that re-fires this effect — the two disagree for
    // exactly one commit, and announcing under both numbers would put a second
    // hello on the wire for one coordinator.
    const key = `${coordinatorEpochRef.current}|${peerKey}`;
    if (announcedKeyRef.current === key) return;
    announcedKeyRef.current = key;
    coordinatorRef.current?.announce();
  }, [dcOpen, peerKey, coordinatorGen]);

  // A codename identifies a peer, not a seat: when the roster changes it is
  // retired until a live hello renews it. Mislabelling a new arrival with the
  // departed agent's codename is worse than falling back to the positional
  // label. A channel blip is NOT churn — the same peer is still on the line,
  // so the claim stands.
  //
  // Adjusted during render rather than in an effect: the retire lands in the
  // SAME render as the roster change, so the departed agent's codename is
  // never painted onto the new one for a frame.
  const [prevPeerKey, setPrevPeerKey] = useState(peerKey);
  if (prevPeerKey !== peerKey) {
    setPrevPeerKey(peerKey);
    setPartnerCodename(null);
  }

  // ---------------------------------------------------------------------
  // Panel derivation. Take-in-progress states outrank the readiness gates:
  // losing a peer mid-take must not swap the Cut button for a head count.
  // ---------------------------------------------------------------------
  const visibleFaults = startFault ? [startFault, ...faults] : faults;
  const faultShown = visibleFaults.length > 0 && faultKey(visibleFaults) !== dismissedKey;

  // The take-compromised latch (see the PodcastTake field). Adjusted during
  // render, like the codename retire above, so it lands in the SAME render as
  // the fault that set it — a device bar that unlocks one frame late is a bar
  // the operator can still be locked out of at the moment they reach for it.
  // Keyed on visibleFaults, not on faultShown: dismissing is an
  // acknowledgement of the alarm, never a repair of the take.
  if (!faultedThisTake && visibleFaults.length > 0) {
    setFaultedThisTake(true);
  }

  function derivePanel(): PodcastPanelState {
    if (!supported) return { kind: "unsupported" };
    if (phase !== "idle") {
      if (phase === "stopping") return { kind: "stopping" };
      // A failed start holds its banner until the operator stands it down —
      // dismissing it ends the take rather than returning to the tape.
      if (phase === "failed") return { kind: "fault", faults: visibleFaults, partnerCodename };
      if (faultShown) return { kind: "fault", faults: visibleFaults, partnerCodename };
      if (phase === "countdown") return { kind: "countdown", secondsLeft: countdownS };
      return {
        kind: "rolling",
        elapsedS: meter.elapsedS,
        localBytes: meter.localBytes,
        partnerBytes: meter.partnerBytes,
        partnerCodename,
      };
    }
    if (!enabled || !username || peerCount !== 1) return { kind: "not-two", count: peerCount + 1 };
    if (vaultPerm !== "granted") {
      return { kind: "vault-needed", permission: vaultPerm === "prompt" ? "prompt" : "unset" };
    }
    // The roster is not enough: during a channel rebuild the peer stays listed
    // while the bus underneath is dropping every send. Rolling in that window
    // would put a pod/roll on the floor and strand us in a countdown nobody
    // acked. (Ordered last so the actionable vault step is still offered while
    // the line comes back on its own.)
    if (!dcOpen) return { kind: "link-down" };
    // canSend is a placeholder here — this hook knows nothing about the
    // episode exchange. Task 11's mergePanel (hooks/useEpisodeExchange.ts)
    // always overwrites it with the real value before the panel renders.
    return {
      kind: "armed",
      canSend: false,
      partnerCodename,
    };
  }

  const panel = derivePanel();

  async function refreshVault(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch {
      // picker dismissed / permission refused — the probe below tells the truth
    }
    try {
      setVaultPerm(await vaultPermission());
    } catch {
      setVaultPerm("unset");
    }
  }

  return {
    panel,
    partnerCodename,
    myCodename: username,
    bytes: streamBytes,
    lastTakeId,
    faultedThisTake,
    actions: {
      chooseVault: () => refreshVault(chooseVaultFolder),
      grantVault: () => refreshVault(requestVaultAccess),
      // ROLL TAPE is only ever offered from "armed" — the guard makes that a
      // rule rather than a fact about which button the panel happens to show.
      roll: () => {
        const coordinator = coordinatorRef.current;
        // Belt + suspenders: the merged panel already hides the button while
        // a transfer holds the roll (decision 8), this is the backstop.
        if (holdRolls) return;
        if (panel.kind !== "armed" || !coordinator) return;
        // A take still draining its stop (the ~1.25 s tail after a Stand Down
        // from a failed start, say) holds the coordinator's slot: propose()
        // sends nothing and returns null. Entering a countdown on that would
        // be a phantom one — no roll on the wire, no ack, no start.
        const takeId = coordinator.propose();
        if (takeId === null) return;
        beginTake();
        setCountdownS(Math.floor(COUNTDOWN_MS / 1000));
        goPhase("countdown");
      },
      stop: () => {
        if (phaseRef.current === "failed") {
          // Nothing local to cut — just release the wire take.
          coordinatorRef.current?.requestStop();
          releaseTake(true);
          setStartFault(null);
          goPhase("idle");
          return;
        }
        if (phaseRef.current === "idle") return;
        coordinatorRef.current?.requestStop();
      },
      dismissFault: () => {
        if (phaseRef.current === "failed") {
          coordinatorRef.current?.requestStop();
          releaseTake(true);
          setStartFault(null);
          setFaults([]);
          goPhase("idle");
          return;
        }
        setDismissedKey(faultKey(visibleFaults));
      },
    },
  };
}
