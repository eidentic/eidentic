import type { RateLimiterPort, RateLimitResult } from "@eidentic/types";

export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold. */
  capacity: number;
  /** Tokens added per second. Set to 0 for a one-shot allow-N-then-block bucket. */
  refillPerSec: number;
  /** Injectable clock for testing. Defaults to Date.now. */
  now?: () => number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * In-process token-bucket rate limiter implementing `RateLimiterPort` (§20.3).
 *
 * Each unique `key` gets an independent bucket, created lazily on first `acquire`.
 * On each call the bucket is refilled based on elapsed time before the token check,
 * so callers never see more than `capacity` tokens regardless of how long they wait.
 *
 * ## Memory management
 *
 * Bucket entries are evicted opportunistically on `acquire`. A sweep runs at most
 * once per full-refill window (`capacity / refillPerSec * 1000` ms) to keep cost
 * amortised. Entries older than twice the full-refill window are dropped — at that
 * age the bucket would be fully refilled anyway, so eviction is semantically
 * lossless. No background timer is used.
 *
 * @note For multi-process deployments use a store-backed or Redis-backed limiter.
 */
export class InMemoryTokenBucketLimiter implements RateLimiterPort {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, BucketState>();

  /**
   * The eviction threshold in ms: entries older than this are guaranteed to be
   * at full capacity, so removing them is lossless.
   * = (capacity / refillPerSec) * 1000 * 2
   * For zero-refill configs a fixed 24-hour window bounds growth.
   */
  private readonly evictThresholdMs: number;

  /**
   * Sweep runs at most once per this interval. Set to half the eviction
   * threshold so that stale entries are caught within at most one extra window.
   */
  private readonly sweepIntervalMs: number;
  private lastSweepMs = 0;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? (() => Date.now());

    if (opts.refillPerSec > 0) {
      const fullRefillMs = (opts.capacity / opts.refillPerSec) * 1000;
      this.evictThresholdMs = fullRefillMs * 2;
      this.sweepIntervalMs = fullRefillMs; // sweep once per refill window
    } else {
      this.evictThresholdMs = 86_400_000; // 24 h for zero-refill configs
      this.sweepIntervalMs = 3_600_000;   // 1 h sweep for zero-refill configs
    }
  }

  /**
   * Test-only accessor: number of entries currently held in the buckets map.
   * Not part of the `RateLimiterPort` contract.
   */
  get bucketCount(): number {
    return this.buckets.size;
  }

  acquire(key: string, cost = 1): RateLimitResult {
    const nowMs = this.now();

    // Opportunistic sweep: evict stale entries at most once per sweepIntervalMs.
    if (nowMs - this.lastSweepMs >= this.sweepIntervalMs) {
      this._sweep(nowMs);
      this.lastSweepMs = nowMs;
    }

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
    }

    // Refill based on elapsed time.
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }

    // When refillPerSec is 0 the bucket never refills; retryAfterMs is undefined (infinite wait).
    const retryAfterMs = this.refillPerSec > 0
      ? Math.ceil(((cost - bucket.tokens) / this.refillPerSec) * 1000)
      : undefined;
    return { ok: false, retryAfterMs, remaining: Math.floor(bucket.tokens) };
  }

  /**
   * Evict bucket entries older than `evictThresholdMs`. Called opportunistically
   * from `acquire` — no timer involved.
   */
  private _sweep(nowMs: number): void {
    for (const [k, state] of this.buckets) {
      if (nowMs - state.lastRefillMs > this.evictThresholdMs) {
        this.buckets.delete(k);
      }
    }
  }
}
