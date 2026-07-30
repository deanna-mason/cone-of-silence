import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CallBus } from "@/hooks/useCallSession";
import {
  COUNTDOWN_MS,
  ROLL_LEAD_MS,
  TakeCoordinator,
  type TakeCallbacks,
} from "@/lib/podcast/takeProtocol";
import type { Beacon } from "@/lib/podcast/watchdog";
import { MARK_TOTAL_MS } from "@/lib/podcast/toneMark";

// ---------------------------------------------------------------------------
// Fake loopback bus pair: two CallBus instances wired to each other, with a
// controllable one-shot delivery latency per direction (default 0, i.e. next
// tick). Every send is logged so tests can assert on message counts/types
// without depending on TakeCoordinator internals. injectRaw() delivers a
// hand-built wire message straight to one side's listeners, no coordinator
// and no delay — used to simulate a foreign/duplicate sender.
// ---------------------------------------------------------------------------
class FakeBusPair {
  private listeners: [Set<(peerId: string, text: string) => void>, Set<(peerId: string, text: string) => void>] = [
    new Set(),
    new Set(),
  ];
  latency: [number, number] = [0, 0]; // [side0->side1, side1->side0]
  sentLog: { from: 0 | 1; text: string }[] = [];

  private deliver(from: 0 | 1, text: string): void {
    this.sentLog.push({ from, text });
    const to = from === 0 ? 1 : 0;
    setTimeout(() => {
      for (const fn of this.listeners[to]) fn("peer", text);
    }, this.latency[from]);
  }

  bus(idx: 0 | 1): CallBus {
    return {
      sendAll: (text: string) => this.deliver(idx, text),
      sendTo: (_peerId: string, text: string) => {
        this.deliver(idx, text);
        return true;
      },
      onMessage: (fn: (peerId: string, text: string) => void) => {
        this.listeners[idx].add(fn);
        return () => this.listeners[idx].delete(fn);
      },
    };
  }

  injectRaw(to: 0 | 1, text: string): void {
    for (const fn of this.listeners[to]) fn("peer", text);
  }

  countSent(from: 0 | 1, t: string): number {
    return this.sentLog.filter((e) => e.from === from && (JSON.parse(e.text) as { t: string }).t === t).length;
  }
}

interface LogEntry {
  name: string;
  at: number;
  arg?: unknown;
}

function makeCb(): { cb: TakeCallbacks; log: LogEntry[] } {
  const log: LogEntry[] = [];
  const cb: TakeCallbacks = {
    onPartnerCodename: vi.fn((name: string) => log.push({ name: "onPartnerCodename", at: Date.now(), arg: name })),
    onCountdown: vi.fn((msLeft: number) => log.push({ name: "onCountdown", at: Date.now(), arg: msLeft })),
    onStartRecorders: vi.fn((takeId: string) => log.push({ name: "onStartRecorders", at: Date.now(), arg: takeId })),
    onMark: vi.fn(() => log.push({ name: "onMark", at: Date.now() })),
    onStopMark: vi.fn(() => log.push({ name: "onStopMark", at: Date.now() })),
    onStopRecorders: vi.fn((takeId: string) => log.push({ name: "onStopRecorders", at: Date.now(), arg: takeId })),
    onBeacon: vi.fn((b: Beacon) => log.push({ name: "onBeacon", at: Date.now(), arg: b })),
  };
  return { cb, log };
}

const START = new Date("2026-01-01T00:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hello handshake", () => {
  it("exchanges codenames both directions, with exactly one hello sent per side", () => {
    const pair = new FakeBusPair();
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);

    a.hello();
    b.hello();
    vi.runAllTimers();

    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(1);
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("Bravo");
    expect(cbB.onPartnerCodename).toHaveBeenCalledTimes(1);
    expect(cbB.onPartnerCodename).toHaveBeenCalledWith("Alpha");
    expect(pair.countSent(0, "pod/hello")).toBe(1);
    expect(pair.countSent(1, "pod/hello")).toBe(1);

    a.dispose();
    b.dispose();
  });

  it("still completes when only one side calls hello() explicitly (auto-reply, no storm)", () => {
    const pair = new FakeBusPair();
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);

    a.hello();
    vi.runAllTimers();

    expect(cbB.onPartnerCodename).toHaveBeenCalledWith("Alpha");
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("Bravo");
    expect(pair.countSent(0, "pod/hello")).toBe(1);
    expect(pair.countSent(1, "pod/hello")).toBe(1);

    a.dispose();
    b.dispose();
  });
});

describe("propose -> ack -> scheduled roll", () => {
  it("both sides fire onStartRecorders then onMark, ROLL_LEAD_MS apart, same takeId, recorders strictly before mark", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA, log: logA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);

    expect(cbA.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbB.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);

    const startA = logA.find((e) => e.name === "onStartRecorders")!.at;
    const markA = logA.find((e) => e.name === "onMark")!.at;
    const startB = logB.find((e) => e.name === "onStartRecorders")!.at;
    const markB = logB.find((e) => e.name === "onMark")!.at;

    expect(startA).toBeLessThan(markA);
    expect(startB).toBeLessThan(markB);
    expect(markA - startA).toBe(ROLL_LEAD_MS);
    expect(markB - startB).toBe(ROLL_LEAD_MS);

    a.dispose();
    b.dispose();
  });
});

describe("clock-offset handling", () => {
  it("partner's onMark lands within 100ms of the proposer's true instant despite +200ms skew / 100ms RTT", () => {
    const pair = new FakeBusPair();
    pair.latency = [50, 50]; // symmetric 50ms each way => 100ms RTT
    const { cb: cbA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB, { now: () => Date.now() + 200 });

    a.hello();
    b.hello();
    vi.advanceTimersByTime(1_000); // let hello + best-of-3 ping rounds settle

    const trueInstantAtPropose = Date.now();
    const takeId = a.propose();
    const trueMarkInstant = trueInstantAtPropose + COUNTDOWN_MS;

    vi.advanceTimersByTime(COUNTDOWN_MS + 200);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStartRecorders).toHaveBeenCalledWith(takeId);
    const markEvent = logB.find((e) => e.name === "onMark");
    expect(markEvent).toBeDefined();
    expect(Math.abs(markEvent!.at - trueMarkInstant)).toBeLessThanOrEqual(100);

    a.dispose();
    b.dispose();
  });
});

describe("stop handshake", () => {
  it("requestStop from the non-proposer drives onStopMark then onStopRecorders on both sides, MARK_TOTAL_MS + 250 apart", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA, log: logA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // through the mark, both rolling

    b.requestStop(); // the NON-proposer side
    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 250 + 100);

    expect(cbA.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbA.onStopRecorders).toHaveBeenCalledWith(takeId);
    expect(cbB.onStopRecorders).toHaveBeenCalledWith(takeId);

    const stopMarkA = logA.find((e) => e.name === "onStopMark")!.at;
    const stopRecA = logA.find((e) => e.name === "onStopRecorders")!.at;
    const stopMarkB = logB.find((e) => e.name === "onStopMark")!.at;
    const stopRecB = logB.find((e) => e.name === "onStopRecorders")!.at;

    expect(stopRecA - stopMarkA).toBe(MARK_TOTAL_MS + 250);
    expect(stopRecB - stopMarkB).toBe(MARK_TOTAL_MS + 250);

    a.dispose();
    b.dispose();
  });

  it("requestStop from the PROPOSER side also drives onStopMark/onStopRecorders on both sides", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA, log: logA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);

    a.requestStop(); // the proposer itself
    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 250 + 100);

    expect(cbA.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbA.onStopRecorders).toHaveBeenCalledWith(takeId);
    expect(cbB.onStopRecorders).toHaveBeenCalledWith(takeId);
    expect(logA.find((e) => e.name === "onStopRecorders")!.at - logA.find((e) => e.name === "onStopMark")!.at).toBe(
      MARK_TOTAL_MS + 250,
    );
    expect(logB.find((e) => e.name === "onStopRecorders")!.at - logB.find((e) => e.name === "onStopMark")!.at).toBe(
      MARK_TOTAL_MS + 250,
    );

    a.dispose();
    b.dispose();
  });
});

describe("simultaneous propose", () => {
  it("resolves a mutual propose race via a deterministic takeId tie-break — no permanent deadlock", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA, log: logA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    // Both sides propose before either pod/roll has crossed the wire.
    const takeIdA = a.propose();
    const takeIdB = b.propose();
    const winner = takeIdA < takeIdB ? takeIdA : takeIdB;

    vi.advanceTimersByTime(COUNTDOWN_MS + 200);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(logA.find((e) => e.name === "onStartRecorders")!.arg).toBe(winner);
    expect(logB.find((e) => e.name === "onStartRecorders")!.arg).toBe(winner);

    a.dispose();
    b.dispose();
  });
});

describe("beacons", () => {
  it("round-trip via onBeacon in both directions", () => {
    const pair = new FakeBusPair();
    pair.latency = [5, 5];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);

    const beaconAtoB: Beacon = { rolling: true, bytes: 1234, camOk: true, micOk: false, fault: null };
    const beaconBtoA: Beacon = { rolling: false, bytes: 0, camOk: false, micOk: false, fault: "camera-lost" };

    a.sendBeacon(beaconAtoB);
    b.sendBeacon(beaconBtoA);
    vi.advanceTimersByTime(5);

    expect(cbB.onBeacon).toHaveBeenCalledWith(beaconAtoB);
    expect(cbA.onBeacon).toHaveBeenCalledWith(beaconBtoA);

    a.dispose();
    b.dispose();
  });
});

describe("dispose", () => {
  it("cancels every pending timer — no callback fires after dispose, even advancing past every deadline", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    a.propose();
    vi.advanceTimersByTime(20); // roll + roll-ack land; both sides schedule, nothing fires yet
    b.requestStop(); // schedules stop timers too, before disposal

    a.dispose();
    b.dispose();

    vi.advanceTimersByTime(COUNTDOWN_MS + 1_000 + MARK_TOTAL_MS + 5_000);

    for (const cb of [cbA, cbB]) {
      expect(cb.onCountdown).not.toHaveBeenCalled();
      expect(cb.onStartRecorders).not.toHaveBeenCalled();
      expect(cb.onMark).not.toHaveBeenCalled();
      expect(cb.onStopMark).not.toHaveBeenCalled();
      expect(cb.onStopRecorders).not.toHaveBeenCalled();
    }
  });
});

describe("one take in flight", () => {
  it("ignores a second pod/roll while a take is already active", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose();
    vi.advanceTimersByTime(20); // roll lands on B, ack lands back on A
    expect(pair.countSent(1, "pod/roll-ack")).toBe(1);

    // Foreign/duplicate second roll targeting B while its take is active.
    pair.injectRaw(1, JSON.stringify({ t: "pod/roll", takeId: "take-bogus-0000", startAtMs: Date.now() + 5_000 }));

    expect(pair.countSent(1, "pod/roll-ack")).toBe(1); // no second ack

    vi.advanceTimersByTime(COUNTDOWN_MS);

    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(logB.filter((e) => e.name === "onStartRecorders").map((e) => e.arg)).toEqual([takeId]);

    a.dispose();
    b.dispose();
  });
});
