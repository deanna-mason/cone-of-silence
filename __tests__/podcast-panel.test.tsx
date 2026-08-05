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
    fireEvent.click(screen.getByRole("button", { name: "Headphones" }));
    expect(cb.onDeclarePhones).toHaveBeenCalledWith("headphones");
    fireEvent.click(screen.getByRole("button", { name: "Speakers" }));
    expect(cb.onDeclarePhones).toHaveBeenCalledWith("speakers");
  });

  test("armed — the remembered answer is hinted while unanswered, and never counts as an answer", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, lastPhones: "speakers" });
    expect(screen.getByRole("button", { name: "Speakers" }).hasAttribute("data-remembered")).toBe(true);
    expect(screen.getByRole("button", { name: "Headphones" }).hasAttribute("data-remembered")).toBe(false);
    // A hint is not an answer: Roll Tape is still gated.
    expect((screen.getByRole("button", { name: "Roll Tape" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("armed — answering collapses the pair to one chip that toggles the other way", () => {
    // The pair costs more width than the row has once Send + Roll are present
    // (measured — it pushed Roll Tape outside the border, 8/5), so the answer
    // reads back as a single chip.
    const cb = renderState({ kind: "armed", canSend: false, ...PHONES_NONE, phones: "speakers" });
    expect(screen.queryByRole("button", { name: "Headphones" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Speakers" }));
    expect(cb.onDeclarePhones).toHaveBeenCalledWith("headphones");
    cleanup();
    const cb2 = renderState({ kind: "armed", canSend: false, ...PHONES_NONE, phones: "headphones" });
    expect(screen.queryByRole("button", { name: "Speakers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Headphones" }));
    expect(cb2.onDeclarePhones).toHaveBeenCalledWith("speakers");
  });

  test("armed — an unconfirmed partner is named; a confirmed pair says nothing", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, partnerCodename: "icecream" });
    expect(screen.getByText("icecream: not confirmed")).toBeDefined();
    cleanup();
    // Calm case: both on headphones — no status text at all. Silence is the
    // default; the row is width-critical and a confirmed pair needs no words.
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE,
      phones: "headphones", partnerCodename: "icecream", partnerPhones: "headphones",
    });
    expect(screen.queryByText(/icecream/)).toBeNull();
  });

  // The declaration cannot make a speakers take echo-free (Chrome won't give a
  // second capture of an in-call mic its own echo canceller — recordGraph.ts),
  // so the copy must WARN and must never claim protection. "echo-guard" as a
  // promise was withdrawn 8/5 after it blocked a real take.
  test("armed — an open-speakers side is named and warned, never reassured", () => {
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE, partnerCodename: "icecream", partnerPhones: "speakers",
    });
    expect(screen.getByText("icecream on open speakers — that tape will carry echo")).toBeDefined();
    cleanup();
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE, phones: "speakers",
      partnerCodename: "icecream", partnerPhones: "headphones",
    });
    expect(screen.getByText("You on open speakers — that tape will carry echo")).toBeDefined();
    cleanup();
    // Both sides on speakers: both named in one line.
    renderState({
      kind: "armed", canSend: false, ...PHONES_NONE, phones: "speakers",
      partnerCodename: "icecream", partnerPhones: "speakers",
    });
    expect(screen.getByText("You + icecream on open speakers — that tape will carry echo")).toBeDefined();
  });

  test("armed — the kicker asks the question until it is answered", () => {
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE });
    expect(screen.getByText("◈ Headphones?")).toBeDefined();
    cleanup();
    renderState({ kind: "armed", canSend: false, ...PHONES_NONE, phones: "headphones" });
    expect(screen.getByText("◈ Ready to Roll")).toBeDefined();
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
    expect(screen.getByText("YOU + Falcon: OPEN SPEAKERS")).toBeDefined();
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

  // The retired "echo-guard" cause (8/5) is unreachable from this build but
  // still renderable, so a partner on the older build beacons words rather
  // than "PARTNER: undefined" — see lib/podcast/watchdog.ts.
  test("fault — the retired echo-guard cause still renders as words", () => {
    renderState({
      kind: "fault",
      partnerCodename: null,
      faults: [{ side: "local", cause: "echo-guard" }],
    });
    expect(screen.getByText("YOUR RECORDER FAILED")).toBeDefined();
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

  // 8/5 drill: this card truncated to "Transmission Interrupted The li…" —
  // the one state whose whole job is explaining a stall.
  test("xfer-interrupted — the message may wrap and is never ellipsized", () => {
    const { container } = render(
      <PodcastPanel
        state={{ kind: "xfer-interrupted", direction: "send", canResend: true }}
        {...callbacks()}
      />,
    );
    const message = screen.getByText(
      "The line dropped mid-reel. Committed parts are safe in the vault.",
    );
    expect(message.className).not.toContain("truncate");
    // The row itself must be free to grow rather than clamp to one line:
    // a min-height floor (same 3rem at rest), never a fixed height.
    const row = container.firstElementChild!;
    const classes = row.className.split(/\s+/);
    expect(classes).toContain("flex-wrap");
    expect(classes).toContain("min-h-12");
    expect(classes).not.toContain("h-12");
  });

  test("xfer-interrupted (partner still rolling) — says so, and still offers Resume", () => {
    const cb = renderState({
      kind: "xfer-interrupted",
      direction: "send",
      canResend: true,
      partnerRolling: true,
    });
    expect(screen.getByText("◈ Transmission Held")).toBeDefined();
    expect(
      screen.getByText("The other chair is still rolling tape. Resume once they cut."),
    ).toBeDefined();
    // The dropped-line copy must not also be on screen — one cause, one message.
    expect(screen.queryByText(/line dropped mid-reel/)).toBeNull();
    // Resume stays live: it works the moment they cut.
    fireEvent.click(screen.getByRole("button", { name: "Resume Transmission" }));
    expect(cb.onResendEpisode).toHaveBeenCalledTimes(1);
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
