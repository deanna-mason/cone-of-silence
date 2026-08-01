// Integration test for hooks/usePodcastTake.ts — the hook that composes the
// vault, the record graph, the recorder, the watchdog and the take
// coordinator into the panel state the room page renders.
//
// The module boundaries that touch real hardware (vault/IndexedDB, record
// graph/getUserMedia, MediaRecorder, klaxon/AudioContext) are faked. The
// TakeCoordinator and the watchdog are the REAL implementations, driven over
// a loopback CallBus pair with a real second coordinator on the far side —
// so the roll handshake, the clock-offset pings and the beacon relay all run
// for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render, renderHook } from "@testing-library/react";
import type { CallBus } from "@/hooks/useCallSession";
import { TakeCoordinator, type TakeCallbacks } from "@/lib/podcast/takeProtocol";
import type { Beacon } from "@/lib/podcast/watchdog";
import { soundKlaxon } from "@/lib/podcast/klaxon";
import VideoTile from "@/components/VideoTile";
import { LAST_TAKE_KEY, usePodcastTake } from "@/hooks/usePodcastTake";

// ---------------------------------------------------------------------------
// Hoisted fake state — vi.mock factories are hoisted above the imports, so
// everything they close over has to be created by vi.hoisted().
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const log: string[] = [];
  const state = {
    vaultPerm: "granted" as "granted" | "prompt" | "unset",
    buildArgs: [] as (string | undefined)[],
    takeDirIds: [] as string[],
    graphs: [] as {
      recordedTrack: unknown;
      rawTrack: { readyState: string; muted: boolean };
      playMark: () => number;
      close: () => void;
    }[],
    recorders: [] as { state: string; stop: () => Promise<unknown> }[],
    failBuild: null as Error | null,
    failTakeDir: null as Error | null,
    failRecorderStop: null as Error | null,
    // Set true to make buildRecordGraph hang until resolveDeferredBuild() is
    // called — simulates a slow gUM/dir start chain (the 2026-07-31 dress
    // rehearsal's confirmed real-hardware failure mode).
    deferBuild: false,
    resolveDeferredBuild: null as (() => void) | null,
  };
  return { log, state };
});

vi.mock("@/lib/authApi", () => ({
  getSession: vi.fn(() => ({ session: "s", username: "Nightingale", expiresAt: "2099-01-01" })),
}));

vi.mock("@/lib/podcast/klaxon", () => ({ soundKlaxon: vi.fn() }));

vi.mock("@/lib/podcast/vault", () => ({
  vaultPermission: vi.fn(async () => H.state.vaultPerm),
  chooseVault: vi.fn(async () => {
    H.log.push("vault:choose");
    H.state.vaultPerm = "granted";
  }),
  requestVaultAccess: vi.fn(async () => {
    H.log.push("vault:grant");
    H.state.vaultPerm = "granted";
    return "granted";
  }),
  openTakeDir: vi.fn(async (takeId: string) => {
    H.state.takeDirIds.push(takeId);
    if (H.state.failTakeDir) throw H.state.failTakeDir;
    return { name: takeId };
  }),
  PartWriter: class {
    bytesWritten = 0;
    constructor(
      readonly dir: unknown,
      readonly base: string,
    ) {}
    async append() {}
    async finish() {
      return [];
    }
  },
}));

vi.mock("@/lib/podcast/recordGraph", () => ({
  ProcessedAudioError: class ProcessedAudioError extends Error {},
  buildRecordGraph: vi.fn(async (audioDeviceId: string | undefined) => {
    H.state.buildArgs.push(audioDeviceId);
    if (H.state.failBuild) throw H.state.failBuild;
    if (H.state.deferBuild) {
      await new Promise<void>((resolve) => {
        H.state.resolveDeferredBuild = resolve;
      });
    }
    H.log.push("graph:build");
    const graph = {
      recordedTrack: { id: "recorded" },
      rawTrack: { readyState: "live", muted: false },
      playMark: vi.fn(() => {
        H.log.push("graph:mark");
        return Date.now();
      }),
      close: vi.fn(() => {
        H.log.push("graph:close");
      }),
    };
    H.state.graphs.push(graph);
    return graph;
  }),
}));

vi.mock("@/lib/podcast/recorder", () => ({
  TakeRecorder: class {
    state = "idle";
    private written = 0;
    constructor(readonly opts: unknown) {
      H.state.recorders.push(this as never);
      H.log.push("recorder:new");
    }
    // Grows every poll so the watchdog's encoder-stalled row never fires in
    // tests that roll for more than STALL_MS.
    bytes() {
      this.written += 1_000;
      return { video: this.written, audio: 0 };
    }
    start() {
      this.state = "rolling";
      H.log.push("recorder:start");
    }
    async stop() {
      this.state = "stopped";
      H.log.push("recorder:stop");
      if (H.state.failRecorderStop) throw H.state.failRecorderStop;
      return { video: [], audio: [] };
    }
  },
}));

// ---------------------------------------------------------------------------
// Loopback bus pair (same shape as __tests__/take-protocol.test.ts).
// ---------------------------------------------------------------------------
class FakeBusPair {
  private listeners: [Set<(p: string, t: string) => void>, Set<(p: string, t: string) => void>] = [
    new Set(),
    new Set(),
  ];
  sentLog: { from: 0 | 1; text: string }[] = [];
  /** Mirrors mesh.sendAll: a closed/absent link is SKIPPED, never queued. The
   *  send is still logged — that is what makes a dropped hello observable. */
  open = true;

  private deliver(from: 0 | 1, text: string): void {
    this.sentLog.push({ from, text });
    if (!this.open) return;
    const to = from === 0 ? 1 : 0;
    setTimeout(() => {
      for (const fn of this.listeners[to]) fn("peer", text);
    }, 0);
  }

  bus(idx: 0 | 1): CallBus {
    return {
      sendAll: (text: string) => this.deliver(idx, text),
      sendTo: (_p: string, text: string) => {
        this.deliver(idx, text);
        return true;
      },
      onMessage: (fn: (p: string, t: string) => void) => {
        this.listeners[idx].add(fn);
        return () => this.listeners[idx].delete(fn);
      },
      // Compiler-forced by CallBus's new required member (Phase 5B Task 3) —
      // untouched by anything this hook test exercises.
      xfer: {
        send: () => false,
        bufferedAmount: () => -1,
        onMessage: () => () => {},
        onDrain: () => () => {},
        onChannelState: () => () => {},
      },
    };
  }

  countSent(from: 0 | 1, t: string): number {
    return this.sentLog.filter(
      (e) => e.from === from && (JSON.parse(e.text) as { t: string }).t === t,
    ).length;
  }

  beaconsFrom(from: 0 | 1): Beacon[] {
    return this.sentLog
      .filter((e) => e.from === from)
      .map((e) => JSON.parse(e.text) as { t: string } & Beacon)
      .filter((m) => m.t === "pod/beacon");
  }
}

function partnerCallbacks(): TakeCallbacks {
  return {
    onPartnerCodename: vi.fn(),
    onCountdown: vi.fn(),
    onStartRecorders: vi.fn(),
    onMark: vi.fn(),
    onStopMark: vi.fn(),
    onStopRecorders: vi.fn(),
    onAborted: vi.fn(),
    onBeacon: vi.fn(),
  };
}

const START = new Date("2026-01-01T00:00:00.000Z").getTime();

type Args = Parameters<typeof usePodcastTake>[0];

function fakeTrack() {
  return { readyState: "live", muted: false } as unknown as MediaStreamTrack;
}

describe("usePodcastTake", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(START);
    H.log.length = 0;
    H.state.vaultPerm = "granted";
    H.state.buildArgs.length = 0;
    H.state.takeDirIds.length = 0;
    H.state.graphs.length = 0;
    H.state.recorders.length = 0;
    H.state.failBuild = null;
    H.state.failTakeDir = null;
    H.state.failRecorderStop = null;
    H.state.deferBuild = false;
    H.state.resolveDeferredBuild = null;
    localStorage.clear(); // isolate cos-last-take across tests
    vi.mocked(soundKlaxon).mockClear();
    // Testing Library sets this around its own wrappers and restores it after;
    // the bare `act` in tick()/rerender paths needs it to stay set.
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    // Chrome-only feature detect: make the environment look supported.
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => {};
    (globalThis as unknown as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: () => true,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
    delete (globalThis as unknown as Record<string, unknown>).MediaRecorder;
  });

  async function tick(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function setup(overrides: Partial<Args> = {}) {
    const pair = new FakeBusPair();
    const bus = pair.bus(0);
    const videoTrack = fakeTrack();
    const partnerCb = partnerCallbacks();
    const partner = new TakeCoordinator(pair.bus(1), "Falcon", partnerCb);
    const props: Args = {
      enabled: true,
      bus,
      dcOpen: true,
      peerIds: ["peer-1"],
      videoTrack,
      audioDeviceId: "mic-1",
      holdRolls: false,
      ...overrides,
    };

    const view = renderHook((p: Args) => usePodcastTake(p), { initialProps: props });
    // Let the mount effects (vault query, hello handshake) settle.
    await tick(1);
    return { pair, partner, partnerCb, videoTrack, view, props };
  }

  /**
   * Drives a full proposer-side roll and stops just past the recorder start
   * (T-500 ms of COUNTDOWN_MS = 3500), BEFORE the first watchdog tick that
   * follows it. Tick phase matters: the 1 Hz interval starts at the roll, so
   * post-roll ticks land at recorder-start +1000, +2000, … and the partner
   * grace window covers exactly the first of them.
   */
  async function rollToRolling(view: Awaited<ReturnType<typeof setup>>["view"]) {
    act(() => view.result.current.actions.roll());
    await tick(3_600);
  }

  /** A healthy partner beaconing once a second, as a real one does. Without
   *  it the watchdog rightly reports partner-silent after 3 s. */
  function partnerHeartbeat(partner: TakeCoordinator): () => void {
    const id = setInterval(() => {
      partner.sendBeacon({ rolling: true, bytes: 8_000, camOk: true, micOk: true, fault: null });
    }, 1_000);
    return () => clearInterval(id);
  }

  it("(a) does nothing at all while disabled — no coordinator, no bus traffic", async () => {
    const { pair, view } = await setup({ enabled: false, peerIds: [] });
    await tick(2_000);

    expect(pair.sentLog.filter((e) => e.from === 0)).toHaveLength(0);
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 1 });
  });

  it("(b) reports the head count when the room is not exactly two agents", async () => {
    const { view } = await setup({ peerIds: [] });
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 1 });
  });

  it("(b2) three agents in the room is still not-two", async () => {
    const { view } = await setup({ peerIds: ["peer-1", "peer-2"] });
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 3 });
  });

  // -------------------------------------------------------------------
  // The roster is not the whole gate. During a channel rebuild the peer is
  // still listed while the bus underneath drops every send — a proposal made
  // then is unackable, and the countdown it opens has no button to leave by.
  // -------------------------------------------------------------------
  it("(b3) two agents but a closed channel is NOT armed, and roll() cannot propose", async () => {
    const { pair, view } = await setup({ dcOpen: false });
    expect(view.result.current.panel).toEqual({ kind: "link-down" });

    act(() => view.result.current.actions.roll());
    await tick(5_000);

    expect(pair.countSent(0, "pod/roll")).toBe(0);
    expect(view.result.current.panel).toEqual({ kind: "link-down" });
  });

  it("(b4) the line coming back re-arms Roll Tape", async () => {
    const { view, props } = await setup({ dcOpen: false });
    expect(view.result.current.panel).toEqual({ kind: "link-down" });

    view.rerender({ ...props, dcOpen: true });
    await tick(50);
    expect(view.result.current.panel).toEqual({ kind: "armed" });
  });

  it("(b5) a channel dropping mid-take never swaps the Cut button for a line-down notice", async () => {
    const { view, props, partner } = await setup();
    const stopHeartbeat = partnerHeartbeat(partner);
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("rolling");

    view.rerender({ ...props, dcOpen: false });
    await tick(10);
    expect(view.result.current.panel.kind).toBe("rolling");
    stopHeartbeat();
  });

  it("(c) an unchosen vault blocks the roll until chooseVault grants it", async () => {
    H.state.vaultPerm = "unset";
    const { view } = await setup();
    expect(view.result.current.panel).toEqual({ kind: "vault-needed", permission: "unset" });

    await act(async () => {
      await view.result.current.actions.chooseVault();
    });
    expect(H.log).toContain("vault:choose");
    expect(view.result.current.panel).toEqual({ kind: "armed" });
  });

  it("(c2) a stored-but-unauthorized vault offers the grant path", async () => {
    H.state.vaultPerm = "prompt";
    const { view } = await setup();
    expect(view.result.current.panel).toEqual({ kind: "vault-needed", permission: "prompt" });

    await act(async () => {
      await view.result.current.actions.grantVault();
    });
    expect(H.log).toContain("vault:grant");
    expect(view.result.current.panel).toEqual({ kind: "armed" });
  });

  it("(d) a full roll counts down, starts the recorders BEFORE the mark, and rolls", async () => {
    const { pair, view } = await setup();
    expect(view.result.current.panel).toEqual({ kind: "armed" });
    expect(view.result.current.partnerCodename).toBe("Falcon");

    act(() => view.result.current.actions.roll());
    expect(view.result.current.panel.kind).toBe("countdown");

    await tick(1_600);
    expect(view.result.current.panel.kind).toBe("countdown");

    await tick(2_400); // past the mark
    expect(view.result.current.panel.kind).toBe("rolling");

    // Recorder up before the tone, and the tone played on the record graph.
    expect(H.log.indexOf("recorder:start")).toBeGreaterThanOrEqual(0);
    expect(H.log.indexOf("graph:mark")).toBeGreaterThan(H.log.indexOf("recorder:start"));
    expect(H.state.buildArgs[0]).toBe("mic-1");
    // The take directory is named for the coordinator's takeId — the same id
    // that crossed the wire in the pod/roll message.
    const rollMsg = pair.sentLog
      .map((e) => JSON.parse(e.text) as { t: string; takeId?: string })
      .find((m) => m.t === "pod/roll")!;
    expect(H.state.takeDirIds[0]).toBe(rollMsg.takeId);

    const panel = view.result.current.panel;
    if (panel.kind !== "rolling") throw new Error("expected rolling");
    expect(panel.partnerCodename).toBe("Falcon");

    // The hook's public `bytes` (video/audio counted separately, mirrored by
    // the room page into window.__cosCall.podBytes for e2e/phase5a-e2e.js)
    // tracks the recorder's own bytes() per tick — an aggregate total can't
    // tell "both streams growing" apart from "one stalled".
    const videoAtRollStart = view.result.current.bytes.video;
    expect(videoAtRollStart).toBeGreaterThan(0);
    expect(view.result.current.bytes.audio).toBe(0); // the fake recorder never produces audio bytes
    await tick(1_000);
    expect(view.result.current.bytes.video).toBeGreaterThan(videoAtRollStart);
  });

  it("(e) a muted camera raises a fault within a tick, sounds the klaxon once, and beacons camOk:false", async () => {
    const { pair, view, videoTrack } = await setup();
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("rolling");

    (videoTrack as unknown as { muted: boolean }).muted = true;
    await tick(1_100);

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "local", cause: "camera-lost" });
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);

    const beacons = pair.beaconsFrom(0);
    expect(beacons[beacons.length - 1]!.camOk).toBe(false);

    // Still one klaxon after another tick of the same fault episode.
    await tick(1_100);
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);
  });

  it("(f) partner beacon silence past BEACON_SILENCE_MS raises partner-silent", async () => {
    const { partner, view } = await setup();
    await rollToRolling(view);

    act(() => {
      partner.sendBeacon({ rolling: true, bytes: 4_000, camOk: true, micOk: true, fault: null });
    });
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("rolling");

    // …then the partner goes quiet.
    await tick(4_000);
    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "remote", cause: "partner-silent" });
  });

  it("(g) cutting the take secures the tape and returns to armed", async () => {
    const { view } = await setup();
    await rollToRolling(view);

    act(() => view.result.current.actions.stop());
    await tick(1_100); // STOP_LEAD_MS
    expect(view.result.current.panel).toEqual({ kind: "stopping" });

    await tick(2_000); // mark + tail
    expect(H.log).toContain("recorder:stop");
    expect(H.log).toContain("graph:close");
    expect(view.result.current.panel).toEqual({ kind: "armed" });
  });

  it("closes the record graph when the hook is disabled mid-take", async () => {
    const { view } = await setup();
    await rollToRolling(view);
    expect(H.log).toContain("graph:build");

    view.unmount();
    expect(H.log).toContain("graph:close");
  });

  it("reports unsupported browsers regardless of everything else", async () => {
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
    const { view } = await setup();
    expect(view.result.current.panel).toEqual({ kind: "unsupported" });
  });

  // -------------------------------------------------------------------
  // The hello handshake has to survive a closed channel. The bus under it
  // (mesh.sendAll) skips a closed link instead of queueing, so announcing at
  // coordinator construction — before any peer or channel exists — loses the
  // hello permanently: no codename, and no clock-offset estimate either,
  // since the ping round only starts once a hello has been RECEIVED.
  // -------------------------------------------------------------------
  it("(h) announces on the channel opening, not at construction — a hello sent while closed is lost", async () => {
    const pair = new FakeBusPair();
    pair.open = false; // channel not up yet: every send is dropped
    const bus = pair.bus(0);
    const partner = new TakeCoordinator(pair.bus(1), "Falcon", partnerCallbacks());
    const props: Args = {
      enabled: true,
      bus,
      dcOpen: false,
      peerIds: ["peer-1"],
      videoTrack: fakeTrack(),
      audioDeviceId: "mic-1",
      holdRolls: false,
    };
    const view = renderHook((p: Args) => usePodcastTake(p), { initialProps: props });
    await tick(50);

    // Whatever was announced now would be thrown away — so nothing is.
    expect(pair.countSent(0, "pod/hello")).toBe(0);
    expect(view.result.current.partnerCodename).toBeNull();

    // Channel opens.
    pair.open = true;
    view.rerender({ ...props, dcOpen: true });
    await tick(50);

    expect(pair.countSent(0, "pod/hello")).toBe(1);
    expect(view.result.current.partnerCodename).toBe("Falcon");
    // …and the offset estimate is reachable again: pinging only starts once a
    // hello has been received, so this is the half that silently died before.
    expect(pair.countSent(0, "pod/ping")).toBeGreaterThan(0);
    view.unmount();
    partner.dispose();
  });

  it("(h2) re-announces when the channel is rebuilt, without restarting the clock estimate", async () => {
    const { pair, view, props } = await setup();
    await tick(100); // let the best-of-3 ping rounds finish
    expect(view.result.current.partnerCodename).toBe("Falcon");
    const pingsAfterFirstOpen = pair.countSent(0, "pod/ping");
    expect(pingsAfterFirstOpen).toBeGreaterThan(0);

    view.rerender({ ...props, dcOpen: false });
    await tick(10);
    // A blip is not churn: the same peer is still on the line, so the claim
    // stands rather than flickering back to a positional label.
    expect(view.result.current.partnerCodename).toBe("Falcon");

    view.rerender({ ...props, dcOpen: true });
    await tick(50);
    expect(view.result.current.partnerCodename).toBe("Falcon");
    expect(pair.countSent(0, "pod/hello")).toBe(2);
    // No second ping round: a re-announce must not disturb an offset already
    // in hand (this can land mid-take).
    expect(pair.countSent(0, "pod/ping")).toBe(pingsAfterFirstOpen);
  });

  it("(h3) a codename never outlives the peer that claimed it", async () => {
    const { pair, view, props } = await setup();
    expect(view.result.current.partnerCodename).toBe("Falcon");

    // The codenamed partner leaves and somebody else takes the chair.
    view.rerender({ ...props, peerIds: ["peer-2"] });
    await tick(1);
    expect(view.result.current.partnerCodename).toBeNull();
    // …and we speak first, so a late joiner learns who we are (their own
    // announcement will not be auto-replied to — our reply latch is spent).
    expect(pair.countSent(0, "pod/hello")).toBe(2);
  });

  // -------------------------------------------------------------------
  // Start-chain rejections: the take exists on the wire but nothing local is
  // recording (the `failed` phase).
  // -------------------------------------------------------------------
  it("(i) a refused mic capture raises an encoder fault, klaxons once, and tells the partner", async () => {
    H.state.failBuild = new Error("microphone capture came back with browser processing enabled");
    const { pair, view } = await setup();
    await rollToRolling(view);

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "local", cause: "encoder-error" });
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);
    expect(H.log).not.toContain("recorder:start");

    // The beacon carries the cause even though we never reached `rolling` —
    // evaluate() reports nothing when not rolling, so it is back-filled.
    await tick(1_100);
    const beacons = pair.beaconsFrom(0);
    expect(beacons[beacons.length - 1]!.fault).toBe("encoder-error");
  });

  it("(i2) a vault that will not open is a disk fault, and no capture is left running", async () => {
    H.state.failTakeDir = new Error("permission revoked");
    const { view } = await setup();
    await rollToRolling(view);

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "local", cause: "disk-error" });
    // The graph was built before the directory failed — it must not survive.
    expect(H.log).toContain("graph:build");
    expect(H.log).toContain("graph:close");
  });

  it("(i3) standing down from a failed start ends the take and re-arms", async () => {
    H.state.failBuild = new Error("no mic");
    const { view } = await setup();
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("fault");

    act(() => view.result.current.actions.dismissFault());
    expect(view.result.current.panel).toEqual({ kind: "armed" });

    // The wire take was released too — the next roll gets a fresh slot.
    H.state.failBuild = null;
    await tick(2_000);
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("rolling");
  });

  // -------------------------------------------------------------------
  // Aborts and teardown.
  // -------------------------------------------------------------------
  it("(j) cutting during the countdown aborts the take — nothing built, slot freed", async () => {
    const { view } = await setup();
    act(() => view.result.current.actions.roll());
    await tick(1_000); // mid-countdown, well before the T-500ms start
    expect(view.result.current.panel.kind).toBe("countdown");

    act(() => view.result.current.actions.stop());
    await tick(1_000);
    expect(H.log).not.toContain("recorder:start");
    expect(view.result.current.panel).toEqual({ kind: "armed" });

    // The abort must not have left the roll timers armed.
    await tick(5_000);
    expect(H.log).not.toContain("graph:build");
    expect(view.result.current.panel).toEqual({ kind: "armed" });

    // And the slot is free: a second roll runs to completion.
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("rolling");
  });

  it("(j2) unmounting mid-countdown leaves no capture and no live timers", async () => {
    const { view } = await setup();
    act(() => view.result.current.actions.roll());
    await tick(1_000);

    view.unmount();
    await tick(10_000); // every roll-phase timer should be dead
    expect(H.log).not.toContain("graph:build");
    expect(H.log).not.toContain("recorder:start");
  });

  // -------------------------------------------------------------------
  // Fault handling while the tape keeps rolling.
  // -------------------------------------------------------------------
  it("(k) Stand Down hides the banner without stopping the tape, and the klaxon re-arms only after a clean tick", async () => {
    const { view, videoTrack, partner } = await setup();
    await rollToRolling(view);
    const stopHeartbeat = partnerHeartbeat(partner);

    (videoTrack as unknown as { muted: boolean }).muted = true;
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("fault");
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);

    act(() => view.result.current.actions.dismissFault());
    // Still recording — dismissing is an acknowledgement, not a cut.
    expect(view.result.current.panel.kind).toBe("rolling");
    expect(H.log).not.toContain("recorder:stop");

    // The same fault, still present, stays dismissed and stays quiet.
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("rolling");
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);

    // Camera returns: one clean tick re-arms the alarm…
    (videoTrack as unknown as { muted: boolean }).muted = false;
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("rolling");

    // …so the next drop sounds again.
    (videoTrack as unknown as { muted: boolean }).muted = true;
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("fault");
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(2);
    stopHeartbeat();
  });

  // -------------------------------------------------------------------
  // The partner grace window: quiet startup lag is forgiven, a fault is not.
  // -------------------------------------------------------------------
  it("(l) a partner still starting up in the first second does not alarm", async () => {
    const { partner, view } = await setup();
    await rollToRolling(view);

    // Their start chain is behind ours — a truthful, harmless "not yet".
    act(() => {
      partner.sendBeacon({ rolling: false, bytes: 0, camOk: true, micOk: true, fault: null });
    });
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("rolling");
    expect(vi.mocked(soundKlaxon)).not.toHaveBeenCalled();
  });

  it("(l2) a partner reporting a real fault in that same window alarms immediately", async () => {
    const { partner, view } = await setup();
    await rollToRolling(view);

    act(() => {
      partner.sendBeacon({
        rolling: false,
        bytes: 0,
        camOk: true,
        micOk: false,
        fault: "disk-error",
      });
    });
    await tick(1_100);

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    // Their cause reaches our banner intact — "REPORTS A FAULT" is not enough
    // to decide re-take vs continue.
    expect(panel.faults).toContainEqual({
      side: "remote",
      cause: "partner-fault",
      detail: "disk-error",
    });
    expect(vi.mocked(soundKlaxon)).toHaveBeenCalledTimes(1);
  });

  it("(l3) a partner who never gets rolling is caught once the window shuts", async () => {
    const { partner, view } = await setup();
    await rollToRolling(view);

    for (let i = 0; i < 3; i++) {
      act(() => {
        partner.sendBeacon({ rolling: false, bytes: 0, camOk: true, micOk: true, fault: null });
      });
      await tick(1_000);
    }

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "remote", cause: "partner-fault" });
  });

  // -------------------------------------------------------------------
  // A discarded take must not haunt the next one.
  // -------------------------------------------------------------------
  it("(m) a late disk error from a discarded recorder never lands on the next take", async () => {
    const { view, partner } = await setup();
    const stopHeartbeat = partnerHeartbeat(partner);
    await rollToRolling(view);

    // Grab the live recorder's fault callback, then end the take.
    const recorder = H.state.recorders[0] as unknown as {
      opts: { onFault: (c: string, d: string) => void };
    };
    act(() => view.result.current.actions.stop());
    await tick(3_500);
    expect(view.result.current.panel).toEqual({ kind: "armed" });

    // Second take, healthy…
    await rollToRolling(view);
    expect(view.result.current.panel.kind).toBe("rolling");

    // …and the FIRST take's writers finally report their failure.
    act(() => recorder.opts.onFault("disk-error", "no space left on device"));
    await tick(1_100);
    expect(view.result.current.panel.kind).toBe("rolling");
    expect(vi.mocked(soundKlaxon)).not.toHaveBeenCalled();
    stopHeartbeat();
  });

  // -------------------------------------------------------------------
  // Defer-mark-or-fault: the 2026-07-31 dress rehearsal found the start tone
  // ABSENT from tape in 5/5 real takes — the gUM/dir start chain is slower
  // than ROLL_LEAD_MS essentially always on real hardware, so onMark's
  // scheduled instant routinely passes before graphRef.current exists. The
  // mark must latch and play the instant the recorder is actually rolling,
  // not clip silently.
  // -------------------------------------------------------------------
  it("a slow gUM start chain defers the start mark instead of clipping it", async () => {
    H.state.deferBuild = true;
    const { view } = await setup();

    act(() => view.result.current.actions.roll());
    // Past T-500 (recorders scheduled to start) AND T (the mark's scheduled
    // instant) — buildRecordGraph is still stalled mid-await the whole time.
    await tick(3_500);

    expect(H.log).not.toContain("recorder:start");
    expect(H.log).not.toContain("graph:mark");

    // The stalled gUM/dir chain finally resolves.
    await act(async () => {
      H.state.resolveDeferredBuild?.();
    });
    await tick(50);

    expect(H.log.filter((l) => l === "graph:mark")).toHaveLength(1);
    expect(H.log.indexOf("graph:mark")).toBeGreaterThan(H.log.indexOf("recorder:start"));
    expect(view.result.current.panel.kind).toBe("rolling");
  });

  it("the fast path is unchanged: the mark plays exactly once, at mark time", async () => {
    const { view } = await setup();

    act(() => view.result.current.actions.roll());
    await tick(3_000); // T-500: recorders start, graph already resolved (fast mock)
    expect(H.log).not.toContain("graph:mark");
    expect(H.log).toContain("recorder:start");

    await tick(500); // T: the mark plays
    expect(H.log.filter((l) => l === "graph:mark")).toHaveLength(1);
    expect(H.log.indexOf("graph:mark")).toBeGreaterThan(H.log.indexOf("recorder:start"));
  });

  // -------------------------------------------------------------------
  // lastTakeId: persists which take has real tape on disk, across reload.
  // -------------------------------------------------------------------
  it("lastTakeId starts null, is set after a completed stop, and survives a fresh mount via localStorage", async () => {
    const { pair, view, props } = await setup();
    expect(view.result.current.lastTakeId).toBeNull();

    await rollToRolling(view);
    const rollMsg = pair.sentLog
      .map((e) => JSON.parse(e.text) as { t: string; takeId?: string })
      .find((m) => m.t === "pod/roll")!;

    act(() => view.result.current.actions.stop());
    await tick(1_100); // STOP_LEAD_MS
    await tick(2_000); // mark + tail
    expect(view.result.current.panel).toEqual({ kind: "armed" });
    expect(view.result.current.lastTakeId).toBe(rollMsg.takeId);

    const stored = JSON.parse(localStorage.getItem(LAST_TAKE_KEY)!) as { takeId: string };
    expect(stored.takeId).toBe(rollMsg.takeId);

    // A fresh mount re-reads it from localStorage — survives reload.
    const fresh = renderHook((p: Args) => usePodcastTake(p), { initialProps: props });
    await tick(1);
    expect(fresh.result.current.lastTakeId).toBe(rollMsg.takeId);
    fresh.unmount();
  });

  it("lastTakeId is recorded even when recorder.stop() rejects", async () => {
    const { pair, view } = await setup();
    await rollToRolling(view);
    const rollMsg = pair.sentLog
      .map((e) => JSON.parse(e.text) as { t: string; takeId?: string })
      .find((m) => m.t === "pod/roll")!;

    H.state.failRecorderStop = new Error("disk write failed");
    act(() => view.result.current.actions.stop());
    await tick(1_100);
    await tick(2_000);

    const panel = view.result.current.panel;
    if (panel.kind !== "fault") throw new Error(`expected fault, got ${panel.kind}`);
    expect(panel.faults).toContainEqual({ side: "local", cause: "disk-error" });
    // Committed parts are real tape either way (decision 11).
    expect(view.result.current.lastTakeId).toBe(rollMsg.takeId);
  });

  // -------------------------------------------------------------------
  // Roll hold: a transfer in flight (decision 8) takes the whole slot
  // out of play, on both the receiving and proposing side.
  // -------------------------------------------------------------------
  it("holdRolls blocks an inbound proposal from ever being acked, and makes roll() a no-op", async () => {
    const { pair, view, partner, partnerCb } = await setup({ holdRolls: true });
    expect(view.result.current.panel).toEqual({ kind: "armed" });

    // Partner proposes — our side must quiet-ignore it (no ack, no slot
    // claim), so the proposer's own abort-if-unacked fires at startAtMs.
    const takeId = partner.propose();
    expect(takeId).not.toBeNull();
    await tick(3_600);

    expect(partnerCb.onAborted).toHaveBeenCalledWith(takeId);
    expect(pair.countSent(0, "pod/roll-ack")).toBe(0);

    // The local roll() action is a no-op too (belt + suspenders — the merged
    // panel already hides the button).
    act(() => view.result.current.actions.roll());
    await tick(1_000);
    expect(pair.countSent(0, "pod/roll")).toBe(0);
    expect(view.result.current.panel).toEqual({ kind: "armed" });
  });
});

describe("VideoTile honest framing", () => {
  beforeEach(() => {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  afterEach(cleanup);

  const stream = {
    addEventListener() {},
    removeEventListener() {},
    getVideoTracks: () => [{}],
  } as unknown as MediaStream;

  it("letterboxes the frame when fullFrame is set", () => {
    const { container } = render(<VideoTile stream={stream} label="You" fullFrame />);
    const video = container.querySelector("video")!;
    expect(video.className).toContain("object-contain");
    expect(video.className).not.toContain("object-cover");
  });

  it("crops to fill by default", () => {
    const { container } = render(<VideoTile stream={stream} label="You" />);
    const video = container.querySelector("video")!;
    expect(video.className).toContain("object-cover");
    expect(video.className).not.toContain("object-contain");
  });
});
