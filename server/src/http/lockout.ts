/**
 * Tracks failed-attempt counts per key (an IP, or `${ip}:${username}`) and
 * locks the key out for `lockoutMs` once it hits `maxFailures` consecutive
 * failures.
 *
 * Entries never expire on their own, so a Map used naively for this grows
 * without bound (every distinct IP/username pair that has ever failed once
 * stays in memory forever). To keep that bounded without adding a timer:
 *   - every read opportunistically evicts the record it looked at, if that
 *     record's lockout window has already fully elapsed;
 *   - if the map has grown past a defensive cap despite that, a full sweep
 *     first drops every already-expired lockout, and then — because a
 *     sub-threshold entry (1..maxFailures-1 failures) never reaches
 *     `lockedUntil !== 0` and so never qualifies for that pass — evicts the
 *     oldest remaining entries by `lastSeen` until the map is back at the
 *     cap. Without that second step, one attacker IP could pin the map open
 *     forever by sending one failed attempt per made-up username (each
 *     landing sub-threshold), which both re-opens the unbounded-memory hole
 *     this class exists to close and turns every subsequent request into an
 *     O(n) sweep that can never shrink anything.
 *
 *   `lastSeen` (rather than pure Map insertion order) is the recency signal
 *   because it's updated on every read too, not just on failure: a
 *   still-locked, actively-probed real key looks "recent" even if it was
 *   first inserted long ago, so it isn't first in line for eviction.
 *   Under sustained attack pressure this can still evict a genuinely
 *   locked-out entry once the map is truly over cap — accepted tradeoff,
 *   since the alternative is unbounded growth.
 */

interface FailureRecord {
  count: number;
  lockedUntil: number;
  lastSeen: number;
}

const MAX_TRACKED_KEYS = 5000;

export class Lockout {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(
    private readonly maxFailures: number,
    private readonly lockoutMs: number,
    // Overridable only so tests can exercise the size-cap sweep without
    // allocating thousands of entries; production call sites never pass it.
    private readonly maxTrackedKeys = MAX_TRACKED_KEYS,
  ) {}

  /** Number of tracked keys. Exposed for tests verifying eviction behavior. */
  get size(): number {
    return this.failures.size;
  }

  /** True if `key` is currently locked out. */
  isLocked(key: string): boolean {
    const record = this.read(key);
    return record !== undefined && record.lockedUntil > Date.now();
  }

  /** Record a failed attempt for `key`, locking it out once `maxFailures` is reached. */
  recordFailure(key: string): void {
    const record = this.read(key);
    const count = (record?.count ?? 0) + 1;
    this.failures.set(key, {
      count,
      lockedUntil: count >= this.maxFailures ? Date.now() + this.lockoutMs : 0,
      lastSeen: Date.now(),
    });
    // Checked again post-insert (read()'s check runs pre-insert, against the
    // size *before* this key is added) so the cap is enforced against the
    // map's actual size instead of leaving it permanently one entry over.
    if (this.failures.size > this.maxTrackedKeys) this.sweep();
  }

  /** Reset `key` on a successful attempt. */
  clear(key: string): void {
    this.failures.delete(key);
  }

  /** Reads a record, evicting it first if its lockout window has fully elapsed. */
  private read(key: string): FailureRecord | undefined {
    let record = this.failures.get(key);
    if (record && record.lockedUntil !== 0 && record.lockedUntil <= Date.now()) {
      this.failures.delete(key);
      record = undefined;
    }
    if (record) record.lastSeen = Date.now();
    if (this.failures.size > this.maxTrackedKeys) this.sweep();
    return record;
  }

  /**
   * Drops every entry whose lockout window has already elapsed, then — if
   * that alone didn't bring the map back under the cap — evicts the oldest
   * remaining entries by `lastSeen` until it is. See the class doc for why
   * both passes are needed.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.failures) {
      if (record.lockedUntil !== 0 && record.lockedUntil <= now) this.failures.delete(key);
    }
    const overflow = this.failures.size - this.maxTrackedKeys;
    if (overflow <= 0) return;
    const oldestFirst = [...this.failures.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [key] of oldestFirst.slice(0, overflow)) this.failures.delete(key);
  }
}
