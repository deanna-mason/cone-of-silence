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
// tick). Every send is logged (including the sendTo target peerId, if any)
// so tests can assert on message counts/types/targeting without depending on
// TakeCoordinator internals. Each side has a fixed peerId (Task 9: the
// coordinator now scopes by peerId, so the fake must actually carry one per
// side instead of a shared hardcoded "peer" string). A third peer can be
// registered into the room (registerThirdPeer) to prove a sendTo() never
// sprays past its target, and injectRaw() delivers a hand-built wire message
// straight to one side's listeners — tagged with an arbitrary sender peerId
// — no coordinator and no delay, used to simulate a foreign/third-party
// sender.
// ---------------------------------------------------------------------------
class FakeBusPair {
  readonly peerIds: [string, string];
  private listeners: [Set<(peerId: string, text: string) => void>, Set<(peerId: string, text: string) => void>] = [
    new Set(),
    new Set(),
  ];
  private extraPeers = new Map<string, Set<(peerId: string, text: string) => void>>();
  latency: [number, number] = [0, 0]; // [side0->side1, side1->side0]
  sentLog: { from: 0 | 1; text: string; toPeerId?: string }[] = [];

  constructor(peerIds: [string, string] = ["peer0", "peer1"]) {
    this.peerIds = peerIds;
  }

  private listenersFor(peerId: string): Set<(peerId: string, text: string) => void> | undefined {
    if (peerId === this.peerIds[0]) return this.listeners[0];
    if (peerId === this.peerIds[1]) return this.listeners[1];
    return this.extraPeers.get(peerId);
  }

  private deliver(from: 0 | 1, text: string, toPeerId?: string): void {
    this.sentLog.push({ from, text, toPeerId });
    const fromPeerId = this.peerIds[from];
    const delayMs = this.latency[from];
    if (toPeerId !== undefined) {
      // sendTo: only the exact target peerId's listeners, if anyone is
      // registered under it — never a spray.
      const targetSet = this.listenersFor(toPeerId);
      if (!targetSet) return;
      setTimeout(() => {
        for (const fn of targetSet) fn(fromPeerId, text);
      }, delayMs);
      return;
    }
    // sendAll: the other pair side plus every registered third peer.
    const to = from === 0 ? 1 : 0;
    setTimeout(() => {
      for (const fn of this.listeners[to]) fn(fromPeerId, text);
    }, delayMs);
    for (const set of this.extraPeers.values()) {
      setTimeout(() => {
        for (const fn of set) fn(fromPeerId, text);
      }, delayMs);
    }
  }

  bus(idx: 0 | 1): CallBus {
    return {
      sendAll: (text: string) => this.deliver(idx, text),
      sendTo: (peerId: string, text: string) => {
        this.deliver(idx, text, peerId);
        return true;
      },
      onMessage: (fn: (peerId: string, text: string) => void) => {
        this.listeners[idx].add(fn);
        return () => this.listeners[idx].delete(fn);
      },
      // Compiler-forced by CallBus's new required member (Phase 5B Task 3) —
      // untouched by anything TakeCoordinator tests here.
      xfer: {
        send: () => false,
        bufferedAmount: () => -1,
        onMessage: () => () => {},
        onDrain: () => () => {},
        onChannelState: () => () => {},
      },
    };
  }

  /** Registers a third listener in the room under its own peerId — lets a
   *  test assert that a sendTo(partnerId, …) targeted send never reaches a
   *  peer who isn't the pinned partner. Returns the received-text log. */
  registerThirdPeer(peerId: string): string[] {
    const received: string[] = [];
    this.extraPeers.set(peerId, new Set([(_from: string, text: string) => received.push(text)]));
    return received;
  }

  /** Delivers a hand-built wire message straight to one side's listeners, no
   *  coordinator and no delay, tagged with an arbitrary sender peerId — used
   *  to simulate a foreign/third-party sender. */
  injectRaw(to: 0 | 1, text: string, fromPeerId = "third-party"): void {
    for (const fn of this.listeners[to]) fn(fromPeerId, text);
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
    onAborted: vi.fn((takeId: string) => log.push({ name: "onAborted", at: Date.now(), arg: takeId })),
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
  // RTT is 200ms and the tolerance below is 50ms — deliberately a quarter of
  // the RTT, not equal to it (an earlier version used a 100ms RTT with a
  // 100ms tolerance, so a sign-flipped correction landed exactly ON the
  // boundary instead of failing). With these numbers: the correct formula
  // (offset = guess − rtt/2) converges to the true skew with ~0 error
  // regardless of RTT, since the ±RTT/2 term cancels out under symmetric
  // latency — so it comfortably clears 50ms. A flipped sign
  // (offset = guess + rtt/2) misses by a full RTT (~200ms, 4x over
  // tolerance); omitting the RTT/2 correction entirely (offset = guess)
  // misses by RTT/2 (~100ms, exactly 2x over tolerance); a fully inverted
  // offset misses by ~400ms; and a sign-flipped toLocal() (subtracting
  // instead of adding the offset) misses by ~400ms too. All of these fail
  // loudly against a 50ms bound.
  it("partner's onMark lands within 50ms of the proposer's true instant despite +200ms skew / 200ms RTT", () => {
    const pair = new FakeBusPair();
    pair.latency = [100, 100]; // symmetric 100ms each way => 200ms RTT
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

    vi.advanceTimersByTime(COUNTDOWN_MS + 300);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStartRecorders).toHaveBeenCalledWith(takeId);
    const markEvent = logB.find((e) => e.name === "onMark");
    expect(markEvent).toBeDefined();
    expect(Math.abs(markEvent!.at - trueMarkInstant)).toBeLessThanOrEqual(50);

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

describe("stop-before-start aborts the take", () => {
  it("requestStop() mid-countdown aborts on both sides — no onStartRecorders/onMark ever fire, slot freed for a fresh propose()", () => {
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
    vi.advanceTimersByTime(500); // well inside the countdown — onStartRecorders would fire around 3000ms

    a.requestStop(); // the proposer aborts its own in-flight take; pod/stop still goes out
    // Advance well past where onStartRecorders/onMark WOULD have fired, on both sides.
    vi.advanceTimersByTime(COUNTDOWN_MS);

    expect(cbA.onStartRecorders).not.toHaveBeenCalled();
    expect(cbA.onMark).not.toHaveBeenCalled();
    expect(cbB.onStartRecorders).not.toHaveBeenCalled();
    expect(cbB.onMark).not.toHaveBeenCalled();
    expect(cbA.onStopMark).not.toHaveBeenCalled();
    expect(cbA.onStopRecorders).not.toHaveBeenCalled();
    expect(cbB.onStopMark).not.toHaveBeenCalled();
    expect(cbB.onStopRecorders).not.toHaveBeenCalled();

    expect(cbA.onAborted).toHaveBeenCalledTimes(1);
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId);
    expect(cbB.onAborted).toHaveBeenCalledTimes(1);
    expect(cbB.onAborted).toHaveBeenCalledWith(takeId);

    // Slot freed on both sides — a fresh propose() works normally afterward.
    const newTakeId = a.propose();
    expect(newTakeId).not.toBe(takeId);
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(logA.find((e) => e.name === "onStartRecorders")!.arg).toBe(newTakeId);
    expect(logB.find((e) => e.name === "onStartRecorders")!.arg).toBe(newTakeId);

    a.dispose();
    b.dispose();
  });

  it("a received pod/stop mid-countdown aborts the take too (non-proposer requests stop, proposer receives it)", () => {
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
    vi.advanceTimersByTime(500); // mid-countdown, well before onStartRecorders would fire

    b.requestStop(); // the NON-proposer aborts; A receives pod/stop and must abort too
    vi.advanceTimersByTime(COUNTDOWN_MS);

    expect(cbA.onStartRecorders).not.toHaveBeenCalled();
    expect(cbA.onMark).not.toHaveBeenCalled();
    expect(cbB.onStartRecorders).not.toHaveBeenCalled();
    expect(cbB.onMark).not.toHaveBeenCalled();
    expect(cbA.onStopMark).not.toHaveBeenCalled();
    expect(cbA.onStopRecorders).not.toHaveBeenCalled();
    expect(cbB.onStopMark).not.toHaveBeenCalled();
    expect(cbB.onStopRecorders).not.toHaveBeenCalled();

    expect(cbA.onAborted).toHaveBeenCalledTimes(1);
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId);
    expect(cbB.onAborted).toHaveBeenCalledTimes(1);
    expect(cbB.onAborted).toHaveBeenCalledWith(takeId);

    // Slot freed on both sides — a fresh propose() from the OTHER side works normally too.
    const newTakeId = b.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(logA.find((e) => e.name === "onStartRecorders")!.arg).toBe(newTakeId);
    expect(logB.find((e) => e.name === "onStartRecorders")!.arg).toBe(newTakeId);

    a.dispose();
    b.dispose();
  });
});

describe("stale startFired does not leak across takes", () => {
  it("propose() resets startFired at slot-claim, so a requestStop() before the next take's ack aborts instead of re-running the stop path", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA, log: logA } = makeCb();
    const { cb: cbB, log: logB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    // Take 1 completes normally, all the way through onStopRecorders — this
    // is what leaves startFired === true on both sides afterward.
    const takeId1 = a.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // past start and mark
    a.requestStop();
    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 250 + 100);

    expect(cbA.onStopRecorders).toHaveBeenCalledWith(takeId1);
    expect(cbB.onStopRecorders).toHaveBeenCalledWith(takeId1);

    // Take 2: propose over a slow ack round trip, then stop BEFORE the ack
    // can possibly land (called synchronously, zero time advanced).
    pair.latency = [300, 300];
    const takeId2 = a.propose();
    expect(takeId2).not.toBe(takeId1);
    a.requestStop();

    // Advance well past every deadline take 2's roll phase would have used,
    // and past the slow 300ms-each-way delivery too.
    vi.advanceTimersByTime(COUNTDOWN_MS + 1_000 + MARK_TOTAL_MS + 1_000);

    // Aborted, not stopped — take 2's recorders never started.
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId2);
    expect(cbB.onAborted).toHaveBeenCalledWith(takeId2);
    // Only take 1's single stop fired — no second onStopMark/onStopRecorders
    // for take 2 (the stale-flag bug would have re-run the stop path here).
    expect(cbA.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStopMark).toHaveBeenCalledTimes(1);
    expect(cbA.onStopRecorders).toHaveBeenCalledTimes(1);
    expect(cbB.onStopRecorders).toHaveBeenCalledTimes(1);
    // No roll timers for take 2 fired on either side.
    expect(logA.filter((e) => e.name === "onStartRecorders").map((e) => e.arg)).toEqual([takeId1]);
    expect(logB.filter((e) => e.name === "onStartRecorders").map((e) => e.arg)).toEqual([takeId1]);
    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);

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

    // Both sides propose before either pod/roll has crossed the wire — each
    // one claims its own free slot, so neither proposal is refused.
    const takeIdA = a.propose()!;
    const takeIdB = b.propose()!;
    expect(takeIdA).not.toBeNull();
    expect(takeIdB).not.toBeNull();
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
    // Task 9: beacons are sendTo(partnerId, …)-targeted, so the partner must
    // be pinned via hello first — every other describe block in this file
    // already does this before touching the coordinator.
    a.hello();
    b.hello();
    vi.runAllTimers();

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
  it("cancels pending roll-phase timers — no onCountdown/onStartRecorders/onMark fire after dispose", () => {
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

    a.dispose();
    b.dispose();

    vi.advanceTimersByTime(COUNTDOWN_MS + 1_000);

    for (const cb of [cbA, cbB]) {
      expect(cb.onCountdown).not.toHaveBeenCalled();
      expect(cb.onStartRecorders).not.toHaveBeenCalled();
      expect(cb.onMark).not.toHaveBeenCalled();
    }
  });

  it("cancels pending stop-phase timers — no onStopMark/onStopRecorders fire after dispose", () => {
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
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // past start AND mark on both sides — genuinely rolling
    b.requestStop(); // start already fired locally on B — normal stop path, schedules stop timers
    vi.advanceTimersByTime(20); // pod/stop lands on A too, which also schedules its stop timers

    a.dispose();
    b.dispose();

    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 5_000);

    for (const cb of [cbA, cbB]) {
      expect(cb.onStopMark).not.toHaveBeenCalled();
      expect(cb.onStopRecorders).not.toHaveBeenCalled();
    }
  });
});

describe("an unacked proposal aborts rather than wedging", () => {
  /** A bus whose sends all go on the floor — exactly what mesh.sendAll does
   *  while the channel is closed (it skips rather than queues). Task 9 fix
   *  round #4: propose() now needs a pinned partner to send anything at all
   *  (see the "canAcceptRoll" describe block's null-partner test), so this
   *  fake also exposes deliverHello() — a way to pin a partner straight
   *  through the coordinator's own subscription, keeping "the bus is dead"
   *  the actual thing under test here rather than "no partner was ever
   *  pinned". */
  function deadBus(sent: string[]): CallBus & { deliverHello(peerId: string, codename: string): void } {
    let listener: ((peerId: string, text: string) => void) | null = null;
    return {
      sendAll: (text: string) => {
        sent.push(text);
      },
      sendTo: (_peerId: string, text: string) => {
        sent.push(text);
        return false;
      },
      onMessage: (fn: (peerId: string, text: string) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      deliverHello(peerId: string, codename: string) {
        listener?.(peerId, JSON.stringify({ t: "pod/hello", codename }));
      },
      // Compiler-forced — see FakeBusPair.bus() above.
      xfer: {
        send: () => false,
        bufferedAmount: () => -1,
        onMessage: () => () => {},
        onDrain: () => () => {},
        onChannelState: () => () => {},
      },
    };
  }

  it("no roll-ack by startAtMs → onAborted, no onStartRecorders/onMark, and the slot is free again", () => {
    const sent: string[] = [];
    const { cb, log } = makeCb();
    const bus = deadBus(sent);
    const a = new TakeCoordinator(bus, "Alpha", cb);
    // Pin a partner straight through the dead bus's own subscription — the
    // send path (not a missing partner) is what's dead here.
    bus.deliverHello("peer-b", "Bravo");
    expect(cb.onPartnerCodename).toHaveBeenCalledWith("Bravo");

    const takeId = a.propose();
    expect(takeId).not.toBeNull();
    // The roll WAS sent (it's the dead bus swallowing it, not a missing partner).
    expect(sent.some((s) => (JSON.parse(s) as { t: string }).t === "pod/roll")).toBe(true);

    // Just short of the start instant: still counting down, nothing aborted.
    vi.advanceTimersByTime(COUNTDOWN_MS - 1);
    expect(cb.onAborted).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb.onAborted).toHaveBeenCalledTimes(1);
    expect(cb.onAborted).toHaveBeenCalledWith(takeId);

    // The roll-phase timers went with it — nothing fires late.
    vi.advanceTimersByTime(COUNTDOWN_MS + MARK_TOTAL_MS + 5_000);
    expect(cb.onStartRecorders).not.toHaveBeenCalled();
    expect(cb.onMark).not.toHaveBeenCalled();
    expect(cb.onStopMark).not.toHaveBeenCalled();
    expect(cb.onStopRecorders).not.toHaveBeenCalled();
    expect(cb.onAborted).toHaveBeenCalledTimes(1);

    // Slot freed: a fresh propose() is accepted and runs normally once acked.
    const newTakeId = a.propose();
    expect(newTakeId).not.toBeNull();
    expect(newTakeId).not.toBe(takeId);
    a.dispose();
    expect(log.filter((e) => e.name === "onStartRecorders")).toHaveLength(0);
  });

  it("an ack that DOES land disarms the abort — the take rolls and stops normally", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose();
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);

    expect(cbA.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbA.onAborted).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });

  it("propose() returns null and sends nothing while a take still holds the slot", () => {
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
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // rolling
    const rollsSoFar = pair.countSent(0, "pod/roll");

    expect(a.propose()).toBeNull();
    expect(pair.countSent(0, "pod/roll")).toBe(rollsSoFar);

    a.dispose();
    b.dispose();
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

    // Duplicate second roll targeting B while its take is already active —
    // from the pinned partner (A), so this exercises the pre-existing
    // already-active guard in onRoll(), not the Task 9 peerId filter.
    pair.injectRaw(
      1,
      JSON.stringify({ t: "pod/roll", takeId: "take-bogus-0000", startAtMs: Date.now() + 5_000 }),
      pair.peerIds[0],
    );

    expect(pair.countSent(1, "pod/roll-ack")).toBe(1); // no second ack

    vi.advanceTimersByTime(COUNTDOWN_MS);

    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(logB.filter((e) => e.name === "onStartRecorders").map((e) => e.arg)).toEqual([takeId]);

    a.dispose();
    b.dispose();
  });
});

describe("peerId scoping (Task 9)", () => {
  it("a third host joining mid-take can no longer clobber partnerCodename", () => {
    const pair = new FakeBusPair(["host-a", "p2"]);
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "MONGOOSE", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("MONGOOSE");

    const takeId = a.propose()!;
    vi.advanceTimersByTime(20); // roll lands on B, ack lands back — A's take is active

    // A third host's hello arrives mid-take — must not clobber the pinned partner.
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "JACKAL" }), "p3");
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(1); // still just the one, MONGOOSE

    // A beacon from the third host is dropped too.
    pair.injectRaw(
      0,
      JSON.stringify({ t: "pod/beacon", rolling: true, bytes: 1, camOk: true, micOk: true, fault: null }),
      "p3",
    );
    expect(cbA.onBeacon).not.toHaveBeenCalled();

    // And a stop from the third host is dropped — the real take is undisturbed.
    pair.injectRaw(0, JSON.stringify({ t: "pod/stop", takeId, markAtMs: Date.now() + 1_000 }), "p3");
    expect(cbA.onAborted).not.toHaveBeenCalled();
    expect(cbA.onStopMark).not.toHaveBeenCalled();

    // The real take with p2 (MONGOOSE) completes normally, undisturbed.
    vi.advanceTimersByTime(COUNTDOWN_MS + 200);
    expect(cbA.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);

    a.dispose();
    b.dispose();
  });

  it("idle re-pin: hello p2 then hello p3 with no take — codename follows p3, and a subsequent roll from p3 works", () => {
    const pair = new FakeBusPair();
    const { cb: cbA } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);

    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "MONGOOSE" }), "p2");
    expect(cbA.onPartnerCodename).toHaveBeenNthCalledWith(1, "MONGOOSE");

    // No take in progress — a hello from a DIFFERENT peerId re-pins rather
    // than being ignored (that's only for a take/unacked proposal in flight).
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "JACKAL" }), "p3");
    expect(cbA.onPartnerCodename).toHaveBeenNthCalledWith(2, "JACKAL");
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(2);

    // A subsequent roll from p3 (the now-pinned partner) is accepted normally.
    const startAtMs = Date.now() + COUNTDOWN_MS;
    pair.injectRaw(0, JSON.stringify({ t: "pod/roll", takeId: "take-from-p3", startAtMs }), "p3");
    expect(
      pair.sentLog.some(
        (e) => e.from === 0 && e.toPeerId === "p3" && (JSON.parse(e.text) as { t: string }).t === "pod/roll-ack",
      ),
    ).toBe(true);

    vi.advanceTimersByTime(COUNTDOWN_MS + 100);
    expect(cbA.onStartRecorders).toHaveBeenCalledWith("take-from-p3");
    expect(cbA.onMark).toHaveBeenCalledTimes(1);

    a.dispose();
  });

  it("post-take heal: after a completed stop, hello from a new peerId re-pins", () => {
    const pair = new FakeBusPair(["host-a", "p2"]);
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "MONGOOSE", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("MONGOOSE");

    const takeId = a.propose()!;
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // rolling
    a.requestStop();
    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 250 + 100); // through the stop
    expect(cbA.onStopRecorders).toHaveBeenCalledWith(takeId);

    // activeTakeId is back to null now — a hello from a new peerId re-pins.
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "JACKAL" }), "p3");
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("JACKAL");
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(2);

    a.dispose();
    b.dispose();
  });

  it("non-hello sends target sendTo(partnerId, …) — never reach a third registered peer", () => {
    const pair = new FakeBusPair();
    pair.latency = [5, 5];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    const thirdPeerLog = pair.registerThirdPeer("p3");

    a.hello();
    b.hello();
    vi.runAllTimers(); // hello both ways + the best-of-3 ping/pong rounds

    const takeId = a.propose()!;
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // roll + roll-ack + rolling

    a.sendBeacon({ rolling: true, bytes: 10, camOk: true, micOk: true, fault: null });
    vi.advanceTimersByTime(10);

    expect(takeId).not.toBeNull();
    expect(cbB.onBeacon).toHaveBeenCalledTimes(1); // the real partner got it
    // hello is sendAll (discovery) — the third peer legitimately hears that.
    // Everything else (ping/pong, roll, roll-ack, beacon) must not reach it.
    // (length check first — every() on an empty array is vacuously true.)
    expect(thirdPeerLog.length).toBeGreaterThan(0);
    const thirdPeerTypes = thirdPeerLog.map((text) => (JSON.parse(text) as { t: string }).t);
    expect(thirdPeerTypes.every((t) => t === "pod/hello")).toBe(true);

    // Every non-hello send this take produced was sendTo-targeted at the
    // ACTUAL partner peerId (ping, roll, roll-ack, beacon) — never sendAll.
    const nonHello = pair.sentLog.filter((e) => (JSON.parse(e.text) as { t: string }).t !== "pod/hello");
    expect(nonHello.length).toBeGreaterThan(0);
    for (const e of nonHello) {
      expect(e.toPeerId).toBe(pair.peerIds[e.from === 0 ? 1 : 0]);
    }

    a.dispose();
    b.dispose();
  });

  it("canAcceptRoll() === false ignores an inbound roll entirely — the proposer's own abort-if-unacked still fires onAborted at startAtMs", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB, { canAcceptRoll: () => false });
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose()!;
    vi.advanceTimersByTime(20); // the roll would have landed on B by now

    expect(pair.countSent(1, "pod/roll-ack")).toBe(0); // ignored quietly — no ack
    expect(cbB.onStartRecorders).not.toHaveBeenCalled(); // no slot claim on B

    vi.advanceTimersByTime(COUNTDOWN_MS); // through A's own startAtMs deadline

    // The shipped abort machinery (5A FIX-2), exercised end-to-end: no ack
    // ever arrived, so A's own unwind fires right on schedule.
    expect(cbA.onAborted).toHaveBeenCalledTimes(1);
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId);
    expect(cbA.onStartRecorders).not.toHaveBeenCalled();
    expect(cbA.onMark).not.toHaveBeenCalled();
    // B never entered any take state at all — no fault, no abort, nothing.
    expect(cbB.onAborted).not.toHaveBeenCalled();
    expect(cbB.onMark).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });

  it("a roll from a third peer while the pinned partner's take is active is ignored — no ack, existing take undisturbed", () => {
    const pair = new FakeBusPair();
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "Bravo", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = b.propose()!; // p2 (side1) proposes; A (side0) claims + acks normally
    vi.advanceTimersByTime(20); // roll lands on A, A's ack lands back on B
    const acksSoFar = pair.countSent(0, "pod/roll-ack");
    expect(acksSoFar).toBe(1); // the one real ack, to B

    // A foreign roll from an unpinned third peer, targeting A while A's take
    // with B is already active.
    pair.injectRaw(0, JSON.stringify({ t: "pod/roll", takeId: "take-bogus-p3", startAtMs: Date.now() + 5_000 }), "p3");

    expect(pair.countSent(0, "pod/roll-ack")).toBe(acksSoFar); // no ack for p3

    vi.advanceTimersByTime(COUNTDOWN_MS + 200);

    expect(cbA.onMark).toHaveBeenCalledTimes(1);
    expect(cbB.onMark).toHaveBeenCalledTimes(1);
    expect(cbA.onStartRecorders).toHaveBeenCalledWith(takeId);
    expect(cbB.onStartRecorders).toHaveBeenCalledWith(takeId);

    a.dispose();
    b.dispose();
  });
});

describe("peerId scoping fix round (Task 9 review)", () => {
  it("a hello ignored mid-take re-pins the moment the take ends — the drill's rejoin heal", () => {
    const pair = new FakeBusPair(["host-a", "p2"]);
    pair.latency = [10, 10];
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "MONGOOSE", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("MONGOOSE");

    const takeId = a.propose()!;
    vi.advanceTimersByTime(COUNTDOWN_MS + 100); // rolling on both sides

    // p2 force-quits and relaunches under a new peerId ("p3") mid-take — the
    // drill's rejoin path. The mid-take guard ignores it (no codename change
    // yet)...
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "JACKAL" }), "p3");
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(1); // still just MONGOOSE

    // ...but the take ending (Cut) applies the stash: re-pinned to p3, and
    // onPartnerCodename fires with p3's codename.
    a.requestStop();
    vi.advanceTimersByTime(1_000 + MARK_TOTAL_MS + 250 + 100); // through the stop
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(2);
    expect(cbA.onPartnerCodename).toHaveBeenLastCalledWith("JACKAL");

    // A subsequent roll targets p3 — not the ghost p2 — proving the re-pin
    // actually took, not just the callback. Scoped to sends AFTER the heal:
    // the original (legitimate) take already put p2-targeted pod/roll/ack
    // traffic in the log.
    const sentBeforeReroll = pair.sentLog.length;
    const newTakeId = a.propose()!;
    expect(newTakeId).not.toBe(takeId);
    const sentAfterReroll = pair.sentLog.slice(sentBeforeReroll);
    expect(
      sentAfterReroll.some((e) => e.from === 0 && e.toPeerId === "p3" && (JSON.parse(e.text) as { t: string }).t === "pod/roll"),
    ).toBe(true);
    expect(sentAfterReroll.some((e) => e.from === 0 && e.toPeerId === "p2")).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("pending hello also applies when the take ends via the unacked-proposal abort path", () => {
    const pair = new FakeBusPair(["host-a", "p2"]);
    const { cb: cbA } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);

    // Pin p2 without a live partner coordinator — nothing will ever ack.
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "MONGOOSE" }), "p2");
    expect(cbA.onPartnerCodename).toHaveBeenCalledWith("MONGOOSE");

    const takeId = a.propose()!; // targets p2; unacked — nobody is listening as p2
    expect(takeId).not.toBeNull();

    // p2 rejoins as p3 mid-proposal (activeTakeId is the still-unacked
    // proposal, so this is "active" too) — ignored + stashed.
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "JACKAL" }), "p3");
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(1);

    // No ack ever arrives — the 5A FIX-2 abort-if-unacked fires at
    // startAtMs, running abortTake(), whose tail applies the stash.
    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId);
    expect(cbA.onPartnerCodename).toHaveBeenCalledTimes(2);
    expect(cbA.onPartnerCodename).toHaveBeenLastCalledWith("JACKAL");

    a.dispose();
  });

  it("propose() returns null and sends nothing when no partner is pinned yet", () => {
    const pair = new FakeBusPair();
    const { cb } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cb);
    // No hello exchanged at all — partnerId is still null.

    const takeId = a.propose();
    expect(takeId).toBeNull();
    expect(pair.countSent(0, "pod/roll")).toBe(0);

    // No phantom countdown either.
    vi.advanceTimersByTime(COUNTDOWN_MS + 100);
    expect(cb.onCountdown).not.toHaveBeenCalled();
    expect(cb.onAborted).not.toHaveBeenCalled();
    expect(cb.onStartRecorders).not.toHaveBeenCalled();

    // Once a partner IS pinned, propose() works normally.
    pair.injectRaw(0, JSON.stringify({ t: "pod/hello", codename: "Bravo" }), pair.peerIds[1]);
    const takeId2 = a.propose();
    expect(takeId2).not.toBeNull();
    expect(pair.countSent(0, "pod/roll")).toBe(1);

    a.dispose();
  });

  it("a third peer's pod/roll with a lexicographically-earlier takeId cannot hijack our unacked proposal", () => {
    // Pre-Task-9 (or with the Task 9 peerId-mismatch guard removed), a
    // second pod/roll while one is active runs onRoll()'s mutual-propose
    // tie-break: it concedes OUR slot to any rival takeId that sorts before
    // ours, no matter who sent it. The mismatch guard added in onRollReceived
    // must drop a THIRD peer's roll before it ever reaches that tie-break.
    const pair = new FakeBusPair(["host-a", "p2"]);
    pair.latency = [10_000, 10_000]; // the real partner's ack can't land in this test's window
    const { cb: cbA } = makeCb();
    const { cb: cbB } = makeCb();
    const a = new TakeCoordinator(pair.bus(0), "Alpha", cbA);
    const b = new TakeCoordinator(pair.bus(1), "MONGOOSE", cbB);
    a.hello();
    b.hello();
    vi.runAllTimers();

    const takeId = a.propose()!; // pendingProposal set, unacked (partner's ack is 10s out)
    expect(takeId).not.toBeNull();

    // A takeId guaranteed to sort BEFORE ours ("!" < every takeId's leading
    // "t"), from an unpinned third peer, targeting A while our proposal is
    // still unacked.
    const hijackTakeId = "!" + takeId;
    expect(hijackTakeId < takeId).toBe(true);
    pair.injectRaw(0, JSON.stringify({ t: "pod/roll", takeId: hijackTakeId, startAtMs: Date.now() + 1_000 }), "p3");

    // No ack for the hijack attempt, and it never got a slot/schedule either.
    expect(pair.sentLog.some((e) => (JSON.parse(e.text) as { t: string }).t === "pod/roll-ack")).toBe(false);
    vi.advanceTimersByTime(1_500); // past the hijack's own (fake) startAtMs
    expect(cbA.onStartRecorders).not.toHaveBeenCalled();

    // OUR proposal is still the one pending — proven by the 5A FIX-2 abort
    // firing for OUR takeId (not the hijack's) once nobody ever acks it.
    vi.advanceTimersByTime(COUNTDOWN_MS);
    expect(cbA.onAborted).toHaveBeenCalledWith(takeId);
    expect(cbA.onAborted).not.toHaveBeenCalledWith(hijackTakeId);
    expect(cbA.onStartRecorders).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });
});
