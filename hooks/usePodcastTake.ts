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

import { useEffect, useRef, useState } from "react";
import type { PodcastPanelState } from "@/components/PodcastPanel";
import type { CallBus } from "@/hooks/useCallSession";
import { getSession } from "@/lib/authApi";
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
  /** The CALL's video track — the same one the recorder encodes. */
  videoTrack: MediaStreamTrack | null;
  audioDeviceId: string | undefined;
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

function faultKey(faults: Fault[]): string {
  return faults
    .map((f) => `${f.side}:${f.cause}`)
    .sort()
    .join("|");
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function usePodcastTake(args: PodcastTakeArgs): PodcastTake {
  const { enabled, bus, dcOpen, peerIds, videoTrack, audioDeviceId } = args;
  const peerCount = peerIds.length;
  const peerKey = peerIds.join("|");

  const [supported] = useState(detectSupport);
  const [username, setUsername] = useState<string | null>(null);
  const [vaultPerm, setVaultPerm] = useState<VaultPermission | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdownS, setCountdownS] = useState(0);
  const [partnerCodename, setPartnerCodename] = useState<string | null>(null);
  const [faults, setFaults] = useState<Fault[]>([]);
  const [startFault, setStartFault] = useState<Fault | null>(null);
  const [dismissedKey, setDismissedKey] = useState("");
  const [meter, setMeter] = useState({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
  const [coordinatorGen, setCoordinatorGen] = useState(0);

  // Anything the coordinator callbacks or the 1 Hz tick need to read lives in
  // a ref: both run outside React's render pass and must never see a stale
  // closure. `phaseRef` is the authoritative phase; `setPhase` only mirrors it
  // for rendering (see goPhase).
  const latest = useRef({ videoTrack, audioDeviceId });
  latest.current = { videoTrack, audioDeviceId };

  const coordinatorRef = useRef<TakeCoordinator | null>(null);
  const graphRef = useRef<RecordGraph | null>(null);
  const recorderRef = useRef<TakeRecorder | null>(null);
  const recorderFaultRef = useRef<{ cause: RecorderFault; detail: string } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const epochRef = useRef(0); // bumped on every teardown — cancels in-flight starts
  const rollingSinceRef = useRef(0);
  const bytesRef = useRef({ total: 0, lastChangeAt: 0 });
  const remoteRef = useRef<{ at: number; beacon: Beacon | null }>({ at: 0, beacon: null });
  const partnerRolledRef = useRef(false);
  const klaxonArmedRef = useRef(true);

  function goPhase(next: Phase): void {
    phaseRef.current = next;
    setPhase(next);
  }

  // ---------------------------------------------------------------------
  // Auth + vault probes (both SSR-safe: effects only).
  // ---------------------------------------------------------------------
  useEffect(() => {
    setUsername(getSession()?.username ?? null);
  }, []);

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
    recorderFaultRef.current = null;
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
    setFaults([]);
    setStartFault(null);
    setDismissedKey("");
    setMeter({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
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
        writers: { video: new PartWriter(dir, "video"), audio: new PartWriter(dir, "audio") },
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
    } catch (err) {
      if (stale()) return;
      failStart("encoder-error", err);
      return;
    }

    const now = Date.now();
    rollingSinceRef.current = now;
    bytesRef.current = { total: 0, lastChangeAt: now };
    goPhase("rolling");
  }

  async function stopRecorders(): Promise<void> {
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

    const camera = latest.current.videoTrack;
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
      onMark: () => graphRef.current?.playMark(),
      onStopMark: () => {
        graphRef.current?.playMark();
        if (phaseRef.current === "rolling" || phaseRef.current === "countdown") {
          goPhase("stopping");
        }
      },
      onStopRecorders: () => {
        if (phaseRef.current === "failed") {
          releaseTake(true);
          return;
        }
        void stopRecorders();
      },
      onAborted: () => {
        // Stopped before the recorders ever got going — nothing to keep.
        releaseTake(true);
        if (phaseRef.current === "failed") return;
        setFaults([]);
        setMeter({ elapsedS: 0, localBytes: 0, partnerBytes: 0 });
        goPhase("idle");
      },
      onBeacon: (b) => {
        if (b.rolling) partnerRolledRef.current = true;
        remoteRef.current = { at: Date.now(), beacon: b };
      },
    });
    coordinatorRef.current = coordinator;
    // NOT announced here: at construction the data channel is usually still
    // closed and the bus drops rather than queues. The effect below does it.
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
    const key = `${coordinatorGen}|${peerKey}`;
    if (announcedKeyRef.current === key) return;
    announcedKeyRef.current = key;
    coordinatorRef.current?.announce();
  }, [dcOpen, peerKey, coordinatorGen]);

  // A codename identifies a peer, not a seat: when the roster changes it is
  // retired until a live hello renews it. Mislabelling a new arrival with the
  // departed agent's codename is worse than falling back to the positional
  // label. A channel blip is NOT churn — the same peer is still on the line,
  // so the claim stands.
  useEffect(() => {
    setPartnerCodename(null);
  }, [peerKey]);

  // ---------------------------------------------------------------------
  // Panel derivation. Take-in-progress states outrank the readiness gates:
  // losing a peer mid-take must not swap the Cut button for a head count.
  // ---------------------------------------------------------------------
  const visibleFaults = startFault ? [startFault, ...faults] : faults;
  const faultShown = visibleFaults.length > 0 && faultKey(visibleFaults) !== dismissedKey;

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
    return { kind: "armed" };
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
    actions: {
      chooseVault: () => refreshVault(chooseVaultFolder),
      grantVault: () => refreshVault(requestVaultAccess),
      // ROLL TAPE is only ever offered from "armed" — the guard makes that a
      // rule rather than a fact about which button the panel happens to show.
      roll: () => {
        if (panel.kind !== "armed" || !coordinatorRef.current) return;
        beginTake();
        setCountdownS(Math.floor(COUNTDOWN_MS / 1000));
        goPhase("countdown");
        coordinatorRef.current.propose();
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
