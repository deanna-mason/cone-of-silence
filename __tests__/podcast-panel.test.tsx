import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import PodcastPanel, { type PodcastPanelState } from "@/components/PodcastPanel";
import { soundKlaxon } from "@/lib/podcast/klaxon";

// vitest globals are off — unmount explicitly or renders leak across tests.
afterEach(cleanup);

function callbacks() {
  return {
    onChooseVault: vi.fn(),
    onGrantVault: vi.fn(),
    onRoll: vi.fn(),
    onStop: vi.fn(),
    onDismissFault: vi.fn(),
  };
}

function renderState(state: PodcastPanelState) {
  const cb = callbacks();
  render(<PodcastPanel state={state} {...cb} />);
  return cb;
}

describe("PodcastPanel", () => {
  test("unsupported — Bureau Browser copy, no action", () => {
    renderState({ kind: "unsupported" });
    expect(screen.getByText("◈ Wrong Equipment")).toBeDefined();
    expect(screen.getByText("Recording Requires the Bureau Browser")).toBeDefined();
    expect(
      screen.getByText("Podcast mode needs Chrome on a Mac. Ordinary calls work anywhere.", {
        exact: false,
      }),
    ).toBeDefined();
  });

  test("not-two — reports the current head count", () => {
    renderState({ kind: "not-two", count: 3 });
    expect(screen.getByText("◈ Two Chairs Only")).toBeDefined();
    expect(
      screen.getByText("The reel rolls for exactly two agents. Presently: 3."),
    ).toBeDefined();
  });

  test("vault-needed (unset) — Choose Tape Vault fires onChooseVault", () => {
    const cb = renderState({ kind: "vault-needed", permission: "unset" });
    fireEvent.click(screen.getByRole("button", { name: "Choose Tape Vault" }));
    expect(cb.onChooseVault).toHaveBeenCalledTimes(1);
    expect(cb.onGrantVault).not.toHaveBeenCalled();
  });

  test("vault-needed (prompt) — Open Tape Vault fires onGrantVault", () => {
    const cb = renderState({ kind: "vault-needed", permission: "prompt" });
    fireEvent.click(screen.getByRole("button", { name: "Open Tape Vault" }));
    expect(cb.onGrantVault).toHaveBeenCalledTimes(1);
    expect(cb.onChooseVault).not.toHaveBeenCalled();
  });

  test("armed — Roll Tape fires onRoll", () => {
    const cb = renderState({ kind: "armed" });
    fireEvent.click(screen.getByRole("button", { name: "Roll Tape" }));
    expect(cb.onRoll).toHaveBeenCalledTimes(1);
  });

  test("countdown — shows the seconds remaining", () => {
    renderState({ kind: "countdown", secondsLeft: 2 });
    expect(screen.getByText("2")).toBeDefined();
  });

  test("rolling — kicker, mm:ss, both gauges, Cut fires onStop", () => {
    const cb = renderState({
      kind: "rolling",
      elapsedS: 125,
      localBytes: 2_400_000,
      partnerBytes: 2_100_000,
      partnerCodename: "Falcon",
    });
    expect(screen.getByText("◈ Reel Rolling")).toBeDefined();
    expect(screen.getByText("02:05")).toBeDefined();
    expect(screen.getByText("You 2.4MB · Falcon 2.1MB")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    expect(cb.onStop).toHaveBeenCalledTimes(1);
  });

  test("rolling — falls back to 'Partner' when no codename is known", () => {
    renderState({
      kind: "rolling",
      elapsedS: 0,
      localBytes: 0,
      partnerBytes: 0,
      partnerCodename: null,
    });
    expect(screen.getByText("You 0.0MB · Partner 0.0MB")).toBeDefined();
  });

  test("fault — lists a local AND a remote fault, Stand Down fires onDismissFault", () => {
    const cb = renderState({
      kind: "fault",
      partnerCodename: "Falcon",
      faults: [
        { side: "local", cause: "camera-lost" },
        { side: "remote", cause: "partner-silent" },
      ],
    });
    const banner = screen.getByRole("alert");
    expect(banner).toBeDefined();
    expect(screen.getByText("◈ Tape Fault")).toBeDefined();
    expect(screen.getByText("YOUR CAMERA DROPPED")).toBeDefined();
    expect(screen.getByText("Falcon: WENT SILENT")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stand Down" }));
    expect(cb.onDismissFault).toHaveBeenCalledTimes(1);
  });

  test("fault — a remote fault names the partner's REAL cause when the beacon carried one", () => {
    renderState({
      kind: "fault",
      partnerCodename: "Falcon",
      faults: [{ side: "remote", cause: "partner-fault", detail: "camera-lost" }],
    });
    // Spec §5A: the banner names whose side AND what failed.
    expect(screen.getByText("Falcon: CAMERA DROPPED")).toBeDefined();
  });

  test("fault — a remote fault with no cause on the wire keeps the generic copy", () => {
    renderState({
      kind: "fault",
      partnerCodename: "Falcon",
      faults: [{ side: "remote", cause: "partner-fault" }],
    });
    expect(screen.getByText("Falcon: REPORTS A FAULT")).toBeDefined();
  });

  test("fault — remote fault falls back to 'PARTNER' when no codename is known", () => {
    renderState({
      kind: "fault",
      partnerCodename: null,
      faults: [{ side: "remote", cause: "partner-fault" }],
    });
    expect(screen.getByText("PARTNER: REPORTS A FAULT")).toBeDefined();
  });

  test("stopping — shows the securing-take copy", () => {
    renderState({ kind: "stopping" });
    expect(screen.getByText("◈ Securing Take")).toBeDefined();
    expect(screen.getByText("Cutting the tape…")).toBeDefined();
  });
});

describe("soundKlaxon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeCtx() {
    const oscs: {
      type: string;
      frequency: { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> };
      connect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }[] = [];
    const closeSpy = vi.fn(async () => {});
    const ctx = {
      currentTime: 0,
      destination: {},
      close: closeSpy,
      createGain: vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
      })),
      createOscillator: vi.fn(() => {
        const rec = {
          type: "",
          frequency: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        oscs.push(rec);
        return rec;
      }),
    };
    return { ctx, oscs, closeSpy };
  }

  test("builds one ctx, three sawtooth oscillators sweeping 440->880Hz, and schedules (not awaits) the close", () => {
    const { ctx, oscs, closeSpy } = fakeCtx();
    const AudioContextCtor = vi.fn(function (this: unknown) {
      return ctx;
    }) as unknown as new (o?: AudioContextOptions) => AudioContext;

    soundKlaxon({ AudioContextCtor });

    expect(AudioContextCtor).toHaveBeenCalledTimes(1);
    expect(oscs).toHaveLength(3);
    expect(oscs.every((o) => o.type === "sawtooth")).toBe(true);
    for (const o of oscs) {
      expect(o.frequency.setValueAtTime).toHaveBeenCalledWith(440, expect.any(Number));
      expect(o.frequency.linearRampToValueAtTime).toHaveBeenCalledWith(880, expect.any(Number));
      expect(o.start).toHaveBeenCalled();
      expect(o.stop).toHaveBeenCalled();
    }

    // Fire-and-forget shape: close is scheduled for later, never called synchronously.
    expect(closeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
