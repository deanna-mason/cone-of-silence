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
 *   - if the map has grown past a defensive cap despite that (e.g. a burst
 *     of many distinct keys locking out at once), a full sweep drops every
 *     already-expired lockout in one pass.
 */

interface FailureRecord {
  count: number;
  lockedUntil: number;
}

const MAX_TRACKED_KEYS = 5000;

export class Lockout {
  private readonly failures = new Map<string, FailureRecord>();

  constructor(
    private readonly maxFailures: number,
    private readonly lockoutMs: number,
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
    });
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
    if (this.failures.size > MAX_TRACKED_KEYS) this.sweep();
    return record;
  }

  /** Drops every entry whose lockout window has already elapsed. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.failures) {
      if (record.lockedUntil !== 0 && record.lockedUntil <= now) this.failures.delete(key);
    }
  }
}
