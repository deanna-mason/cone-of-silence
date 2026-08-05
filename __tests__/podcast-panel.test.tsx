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
    onSendEpisode: vi.fn(),
    onResendEpisode: vi.fn(),
    onDismissXfer: vi.fn(),
    onDeclarePhones: vi.fn(),
  };
}

/** Armed-state phones fields, undeclared everywhere — spread then override. */
const PHONES_NONE = {
  phones: null,
  lastPhones: null,
  partnerPhones: null,
  partnerCodename: null,
} as const;

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

  test("link-down — explains the wait and offers no Roll Tape", () => {
    renderState({ kind: "link-down" });
    expect(screen.getByText("◈ Line Down")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Roll Tape" })).toBeNull();
  });

  test("armed — Roll Tape fires onRoll once declared", () => {
    const cb = renderState({ kind: "armed", canSend: false, ...PHONES_NONE, phones: "headphones" });
    fireEvent.click(screen.getByRole("button", { name: "Roll Tape" }));
    expect(cb.onRoll).toHaveBeenCalledTimes(1);
  });

  test("armed — Roll Tape is disabled while undeclared", () => {
    const cb = renderState({ kind: "armed", canSend: false, ...PHONES_NONE });
    const roll = screen.getByRole("button", { name: "Roll Tape" }) as HTMLButtonElement;
    expect(roll.disabled).toBe(true);
    fireEvent.click(roll);
    expect(cb.onRoll).not.toHaveBeenCalled();
  });

  test("armed — Headphones In / Open Speakers fire onDeclarePhones with the value", () => {
    const cb = renderState({ kind: "armed", canSend: false, ...PHONES_NONE });
    fireEvent.click(screen.getByRole("button", { name: "Headphones In" }));
    expect(cb.onDeclarePhones).toHaveBeenCalledWith("headphones");
    fireEvent.click(screen.getByRole("button", { name: "Open Speakers" }));
    expect(cb.onDeclarePhones).toHaveBeenCalledWith("speakers");
  });

  test("armed — the remembered answer is marked before confirmation, and only then", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, lastPhones: "speakers" });
    const speakers = screen.getByRole("button", { name: "Open Speakers" });
    expect(speakers.hasAttribute("data-remembered")).toBe(true);
    expect(screen.getByRole("button", { name: "Headphones In" }).hasAttribute("data-remembered")).toBe(false);
    cleanup();
    // Once declared, the memory marker disappears (aria-pressed carries state).
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, phones: "speakers", lastPhones: "speakers" });
    const pressed = screen.getByRole("button", { name: "Open Speakers" });
    expect(pressed.hasAttribute("data-remembered")).toBe(false);
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
  });

  test("armed — partner status line: not confirmed / headphones / OPEN SPEAKERS", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, partnerCodename: "icecream" });
    expect(screen.getByText("icecream: not confirmed")).toBeDefined();
    cleanup();
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE, partnerCodename: "icecream", partnerPhones: "headphones",
    });
    expect(screen.getByText("icecream: headphones in")).toBeDefined();
    cleanup();
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE, partnerCodename: "icecream", partnerPhones: "speakers",
    });
    expect(screen.getByText("icecream: OPEN SPEAKERS · echo-guard")).toBeDefined();
  });

  test("armed — no Send Episode button when canSend is false", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE });
    expect(screen.queryByRole("button", { name: "Send Episode" })).toBeNull();
  });

  test("armed — Send Episode shown and fires onSendEpisode when canSend", () => {
    const cb = renderState({ kind: "armed", canSend: true, ...PHONES_NONE });
    fireEvent.click(screen.getByRole("button", { name: "Send Episode" }));
    expect(cb.onSendEpisode).toHaveBeenCalledTimes(1);
    expect(cb.onRoll).not.toHaveBeenCalled();
  });

  test("armed — a restored previous-session take says Send Last Take, not Send Episode", () => {
    const cb = renderState({ kind: "armed", canSend: true, restoredTake: true, ...PHONES_NONE });
    expect(screen.queryByRole("button", { name: "Send Episode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send Last Take" }));
    expect(cb.onSendEpisode).toHaveBeenCalledTimes(1);
  });

  test("armed — delivered shows a static Episode Delivered marker and no Send Episode", () => {
    renderState({ kind: "armed", canSend: true, delivered: true, ...PHONES_NONE });
    expect(screen.getByText("◈ Episode Delivered")).toBeDefined();
    // Even with canSend true, a delivered take never re-offers Send.
    expect(screen.queryByRole("button", { name: "Send Episode" })).toBeNull();
    // Roll Tape stays — record another take to send again.
    expect(screen.getByRole("button", { name: "Roll Tape" })).toBeDefined();
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
      phones: "headphones",
      partnerPhones: "headphones",
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
      phones: null,
      partnerPhones: null,
    });
    expect(screen.getByText("You 0.0MB · Partner 0.0MB")).toBeDefined();
  });

  test("rolling — open-speakers declarations get a loud marker; both-headphones stays silent", () => {
    renderState({
      kind: "rolling",
      elapsedS: 10,
      localBytes: 0,
      partnerBytes: 0,
      partnerCodename: "Falcon",
      phones: "speakers",
      partnerPhones: "speakers",
    });
    expect(screen.getByText("YOU: OPEN SPEAKERS · Falcon: OPEN SPEAKERS · echo-guard on")).toBeDefined();
    cleanup();
    renderState({
      kind: "rolling",
      elapsedS: 10,
      localBytes: 0,
      partnerBytes: 0,
      partnerCodename: "Falcon",
      phones: "headphones",
      partnerPhones: "headphones",
    });
    expect(screen.queryByText(/OPEN SPEAKERS/)).toBeNull();
  });

  test("fault — lists a local AND a remote fault, Acknowledge fires onDismissFault", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
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

  test("fault — echo-guard failure names the remedy", () => {
    renderState({
      kind: "fault",
      partnerCodename: null,
      faults: [{ side: "local", cause: "echo-guard" }],
    });
    expect(screen.getByText("YOUR ECHO-GUARD FAILED — USE HEADPHONES")).toBeDefined();
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

  test("xfer-sending — progress numbers lead the line, file name trails (dropped below sm), no buttons", () => {
    renderState({
      kind: "xfer-sending",
      file: "audio.part001",
      sentBytes: 1_230_000,
      totalBytes: 4_560_000,
      mbps: 1.2,
      etaS: 83,
    });
    expect(screen.getByText("◈ Transmitting")).toBeDefined();
    // Numbers-first, so a narrow-width truncate eats the file name, not the
    // progress readout (the "…transmission t…" bug, 8/3).
    expect(screen.getByText("1.2/4.6 MB · 1.2 MB/s · ETA 01:23")).toBeDefined();
    // The file name trails in its own drop-below-sm span.
    expect(screen.getByText(/audio\.part001/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("xfer-sending — ETA renders as an em dash until a rate is known", () => {
    renderState({
      kind: "xfer-sending",
      file: "audio.part000",
      sentBytes: 0,
      totalBytes: 1_000_000,
      mbps: 0,
      etaS: null,
    });
    expect(screen.getByText("0.0/1.0 MB · 0.0 MB/s · ETA —")).toBeDefined();
    expect(screen.getByText(/audio\.part000/)).toBeDefined();
  });

  test("xfer-receiving — names the sender, no mbps in copy, no buttons", () => {
    renderState({
      kind: "xfer-receiving",
      file: "video.part002",
      committedBytes: 2_000_000,
      totalBytes: 6_000_000,
      mbps: 2.5,
      etaS: 40,
      fromCodename: "Falcon",
    });
    expect(screen.getByText("◈ Incoming Reel")).toBeDefined();
    // Sender + progress numbers lead; the part file name trails (dropped below sm).
    expect(screen.getByText("Falcon · 2.0/6.0 MB · ETA 00:40")).toBeDefined();
    expect(screen.getByText(/video\.part002/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("xfer-receiving — falls back to 'Partner' when no codename is known", () => {
    renderState({
      kind: "xfer-receiving",
      file: "video.part000",
      committedBytes: 0,
      totalBytes: 1_000_000,
      mbps: 0,
      etaS: null,
      fromCodename: null,
    });
    expect(screen.getByText("Partner · 0.0/1.0 MB · ETA —")).toBeDefined();
    expect(screen.getByText(/video\.part000/)).toBeDefined();
  });

  test("xfer-interrupted (send, canResend) — Resume Transmission fires onResendEpisode; Dismiss fires onDismissXfer", () => {
    const cb = renderState({ kind: "xfer-interrupted", direction: "send", canResend: true });
    expect(screen.getByText("◈ Transmission Interrupted")).toBeDefined();
    expect(
      screen.getByText("The line dropped mid-reel. Committed parts are safe in the vault."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Resume Transmission" }));
    expect(cb.onResendEpisode).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(cb.onDismissXfer).toHaveBeenCalledTimes(1);
  });

  test("xfer-interrupted (send, !canResend) — no Resume Transmission button", () => {
    renderState({ kind: "xfer-interrupted", direction: "send", canResend: false });
    expect(screen.queryByRole("button", { name: "Resume Transmission" })).toBeNull();
  });

  test("xfer-interrupted (receive) — never offers Resume Transmission even if canResend were true", () => {
    renderState({ kind: "xfer-interrupted", direction: "receive", canResend: true });
    expect(screen.queryByRole("button", { name: "Resume Transmission" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  test("xfer-done (send) — Episode Delivered, Dismiss fires onDismissXfer", () => {
    const cb = renderState({ kind: "xfer-done", direction: "send", totalBytes: 7_800_000 });
    expect(screen.getByText("◈ Episode Delivered")).toBeDefined();
    expect(screen.getByText("7.8 MB filed.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(cb.onDismissXfer).toHaveBeenCalledTimes(1);
  });

  test("xfer-done (receive) — Episode Received", () => {
    renderState({ kind: "xfer-done", direction: "receive", totalBytes: 100_000 });
    expect(screen.getByText("◈ Episode Received")).toBeDefined();
    expect(screen.getByText("0.1 MB filed.")).toBeDefined();
  });

  test("xfer-fault — hash-mismatch reason gets the damaged-reel copy; alert role; Acknowledge fires onDismissXfer", () => {
    const cb = renderState({ kind: "xfer-fault", reason: "hash-mismatch:audio.part000" });
    const banner = screen.getByRole("alert");
    expect(banner).toBeDefined();
    expect(screen.getByText("◈ Transmission Fault")).toBeDefined();
    expect(
      screen.getByText("A reel arrived damaged and was burned. Resume to send it again."),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(cb.onDismissXfer).toHaveBeenCalledTimes(1);
  });

  test("xfer-fault — any other reason gets the generic themed copy verbatim-ish", () => {
    renderState({ kind: "xfer-fault", reason: "plan:no such directory" });
    expect(
      screen.getByText("The transmission broke down: plan:no such directory."),
    ).toBeDefined();
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
