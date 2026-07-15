import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Lockout } from "../src/http/lockout.js";

describe("Lockout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is not locked before maxFailures is reached", () => {
    const lockout = new Lockout(5, 60_000);
    for (let i = 0; i < 4; i++) lockout.recordFailure("k");
    expect(lockout.isLocked("k")).toBe(false);
  });

  it("locks out after maxFailures consecutive failures, then unlocks after the window", () => {
    const lockout = new Lockout(5, 60_000);
    for (let i = 0; i < 5; i++) lockout.recordFailure("k");
    expect(lockout.isLocked("k")).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(lockout.isLocked("k")).toBe(false);
  });

  it("clear() resets the failure count for a key", () => {
    const lockout = new Lockout(5, 60_000);
    for (let i = 0; i < 4; i++) lockout.recordFailure("k");
    lockout.clear("k");
    lockout.recordFailure("k"); // count restarts at 1, nowhere near locked
    expect(lockout.isLocked("k")).toBe(false);
  });

  it("evicts a stale locked-out entry from memory once its window has elapsed", () => {
    const lockout = new Lockout(5, 60_000);
    for (let i = 0; i < 5; i++) lockout.recordFailure("stale-key");
    expect(lockout.size).toBe(1);
    vi.advanceTimersByTime(61_000);
    // Reading via isLocked() triggers the opportunistic eviction.
    expect(lockout.isLocked("stale-key")).toBe(false);
    expect(lockout.size).toBe(0);
  });

  it("sweeps all expired entries once the map grows past the defensive cap", () => {
    const lockout = new Lockout(1, 1_000);
    for (let i = 0; i < 5001; i++) lockout.recordFailure(`k${i}`); // maxFailures=1 → every key locks immediately
    expect(lockout.size).toBeGreaterThan(5000);
    vi.advanceTimersByTime(1_001);
    // The next write triggers the size-cap sweep as a side effect.
    lockout.recordFailure("trigger");
    expect(lockout.size).toBeLessThanOrEqual(1); // only the freshly-locked "trigger" key remains
  });
});
