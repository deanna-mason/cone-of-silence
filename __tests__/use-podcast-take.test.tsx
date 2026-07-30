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
import { usePodcastTake } from "@/hooks/usePodcastTake";

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

  private deliver(from: 0 | 1, text: string): void {
    this.sentLog.push({ from, text });
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
    };
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
    vi.mocked(soundKlaxon).mockClear();
    // Chrome-only feature detect: make the environment look supported.
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => {};
    (globalThis as unknown as Record<string, unknown>).MediaRecorder = {
      isTypeSupported: () => true,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

    const view = renderHook((props: Args) => usePodcastTake(props), {
      initialProps: {
        enabled: true,
        bus,
        peerCount: 1,
        videoTrack,
        audioDeviceId: "mic-1",
        ...overrides,
      },
    });
    // Let the mount effects (vault query, hello handshake) settle.
    await tick(1);
    return { pair, partner, partnerCb, videoTrack, view };
  }

  /** Drives a full proposer-side roll: armed → countdown → rolling. */
  async function rollToRolling(view: Awaited<ReturnType<typeof setup>>["view"]) {
    act(() => view.result.current.actions.roll());
    await tick(4_000); // COUNTDOWN_MS (3500) + start lead + slack
  }

  it("(a) does nothing at all while disabled — no coordinator, no bus traffic", async () => {
    const { pair, view } = await setup({ enabled: false, peerCount: 0 });
    await tick(2_000);

    expect(pair.sentLog.filter((e) => e.from === 0)).toHaveLength(0);
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 1 });
  });

  it("(b) reports the head count when the room is not exactly two agents", async () => {
    const { view } = await setup({ peerCount: 0 });
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 1 });
  });

  it("(b2) three agents in the room is still not-two", async () => {
    const { view } = await setup({ peerCount: 2 });
    expect(view.result.current.panel).toEqual({ kind: "not-two", count: 3 });
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
