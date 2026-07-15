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

  it("stays at/under the cap even mid-burst, and fully sweeps expired entries once they lapse", () => {
    const lockout = new Lockout(1, 1_000);
    for (let i = 0; i < 5001; i++) lockout.recordFailure(`k${i}`); // maxFailures=1 → every key locks immediately
    // recordFailure's post-insert cap check catches the overflow in the same
    // call that caused it, so the map never sits above the cap even
    // transiently (not just "eventually", once some later call happens to
    // trigger a sweep).
    expect(lockout.size).toBeLessThanOrEqual(5000);
    vi.advanceTimersByTime(1_001);
    // The next write triggers the size-cap sweep as a side effect, which also drops every now-expired entry.
    lockout.recordFailure("trigger");
    expect(lockout.size).toBeLessThanOrEqual(1); // only the freshly-locked "trigger" key remains
  });

  it("stays bounded at the cap even when every entry is sub-threshold (never locked, never expiring)", () => {
    // Real cap is 5000; inject a small one here so the test doesn't need to
    // allocate thousands of entries. maxFailures=5 means a single
    // recordFailure per key (count=1) never reaches lockedUntil !== 0, so
    // the expired-entry pass in sweep() can never evict any of these — only
    // the lastSeen-based eviction added in this change can bound the map.
    const cap = 10;
    const lockout = new Lockout(5, 60_000, cap);
    for (let i = 0; i < cap * 3; i++) {
      lockout.recordFailure(`attacker-ip:made-up-user-${i}`);
      vi.advanceTimersByTime(1); // distinct lastSeen per key so ordering is deterministic
    }
    // None of these ever locked or expired, so only the lastSeen-eviction
    // path added in this change can be responsible for the map not growing
    // to cap * 3 — before this fix, size would equal cap * 3 here.
    expect(lockout.size).toBeGreaterThan(0);
    expect(lockout.size).toBeLessThanOrEqual(cap);
  });
});
