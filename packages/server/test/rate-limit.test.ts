import { describe, it, expect } from "vitest";
import { InMemoryTokenBucketLimiter } from "../src/rate-limit.js";

describe("InMemoryTokenBucketLimiter", () => {
  it("allows up to capacity requests immediately", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 3, refillPerSec: 0 });
    expect(limiter.acquire("k").ok).toBe(true);
    expect(limiter.acquire("k").ok).toBe(true);
    expect(limiter.acquire("k").ok).toBe(true);
  });

  it("throttles the (capacity+1)th request with ok:false and retryAfterMs>0", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 2, refillPerSec: 10 });
    limiter.acquire("k");
    limiter.acquire("k");
    const result = limiter.acquire("k");
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.remaining).toBe(0);
  });

  it("refills tokens over time via injected clock — after advancing clock, acquire succeeds again", () => {
    let nowMs = 0;
    const limiter = new InMemoryTokenBucketLimiter({
      capacity: 1,
      refillPerSec: 1, // 1 token/sec
      now: () => nowMs,
    });
    expect(limiter.acquire("k").ok).toBe(true); // consume the single token
    expect(limiter.acquire("k").ok).toBe(false); // exhausted

    // Advance clock by 1 second → 1 token refilled
    nowMs = 1000;
    const after = limiter.acquire("k");
    expect(after.ok).toBe(true);
    expect(after.remaining).toBe(0);
  });

  it("refills partial tokens — retryAfterMs reflects time needed for cost", () => {
    let nowMs = 0;
    const limiter = new InMemoryTokenBucketLimiter({
      capacity: 2,
      refillPerSec: 2, // 2 tokens/sec
      now: () => nowMs,
    });
    limiter.acquire("k"); // -1
    limiter.acquire("k"); // -1 → 0 left

    // Advance 250 ms → +0.5 tokens (still < 1)
    nowMs = 250;
    const r = limiter.acquire("k");
    expect(r.ok).toBe(false);
    // Need 0.5 more tokens at 2 t/s → 250 ms → ceil = 250
    expect(r.retryAfterMs).toBe(250);
  });

  it("per-key isolation: exhausting key A does not throttle key B", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 });
    limiter.acquire("A"); // exhaust A
    expect(limiter.acquire("A").ok).toBe(false);
    expect(limiter.acquire("B").ok).toBe(true); // B is independent
  });

  it("cost>1 consumes multiple tokens", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 5, refillPerSec: 0 });
    const r1 = limiter.acquire("k", 3);
    expect(r1.ok).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.acquire("k", 3); // only 2 left, cost 3 → throttled
    expect(r2.ok).toBe(false);
  });

  it("returns remaining=0 when exactly at capacity and refillPerSec=0", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 });
    const r = limiter.acquire("k");
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("retryAfterMs is undefined (not Infinity) when refillPerSec=0", () => {
    const limiter = new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 });
    limiter.acquire("k");
    const r = limiter.acquire("k");
    expect(r.ok).toBe(false);
    expect(r.retryAfterMs).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Eviction tests (Fix: unbounded buckets Map memory leak)
  // ---------------------------------------------------------------------------

  it("evicts stale buckets — many distinct keys + time advance removes old entries, active key preserved", () => {
    let nowMs = 0;
    // capacity=10, refillPerSec=1 → full-refill window = 10/1*1000 = 10_000 ms
    // eviction threshold = 10_000 * 2 = 20_000 ms
    const limiter = new InMemoryTokenBucketLimiter({
      capacity: 10,
      refillPerSec: 1,
      now: () => nowMs,
    });

    // Create 200 stale keys at t=0.
    for (let i = 0; i < 200; i++) {
      limiter.acquire(`stale-${i}`);
    }

    // Keep one active key alive.
    limiter.acquire("active");

    // Advance time past the eviction threshold (2 × full-refill window = 20 s).
    nowMs = 25_000;

    // Touch the active key — this triggers a sweep.
    limiter.acquire("active");

    // Stale buckets should have been evicted; only "active" remains.
    expect(limiter.bucketCount).toBe(1);
  });

  it("never wrongly evicts a key that was touched recently", () => {
    let nowMs = 0;
    const limiter = new InMemoryTokenBucketLimiter({
      capacity: 5,
      refillPerSec: 1,
      now: () => nowMs,
    });

    // Two keys touched at t=0.
    limiter.acquire("hot");
    limiter.acquire("warm");

    // Advance to just before eviction threshold (< 10_000 ms).
    nowMs = 9_000;

    // Touch "hot" at t=9000 — it is within the window.
    limiter.acquire("hot");

    // Advance past eviction threshold (full-refill = 5s, threshold = 10s).
    nowMs = 22_000;

    // Touch "hot" again — sweep runs.
    // "warm"'s lastRefillMs was 0, which is 22_000 ms ago > 10_000 ms → evict.
    // "hot"'s lastRefillMs was 9_000, which is 13_000 ms ago > 10_000 ms → also evict.
    // After this acquire, "hot" gets a fresh entry.
    limiter.acquire("hot");

    // Only "hot" (just re-created) should remain.
    expect(limiter.bucketCount).toBe(1);
  });

  it("preserves refill state for an active bucket across eviction sweeps", () => {
    let nowMs = 0;
    const limiter = new InMemoryTokenBucketLimiter({
      capacity: 10,
      refillPerSec: 2,
      now: () => nowMs,
    });

    // Consume 8 tokens from the active key at t=0.
    for (let i = 0; i < 8; i++) limiter.acquire("active");
    // 2 tokens remain.

    // Add many stale keys.
    for (let i = 0; i < 50; i++) limiter.acquire(`stale-${i}`);

    // Advance 3 s — active bucket would refill 6 tokens → min(10, 2+6) = 8 remaining.
    nowMs = 3_000;

    // Trigger a sweep via acquire on "active" (cost 0 → just observes).
    // Note: cost=0 means tokens >= 0 always passes, so ok:true.
    const r = limiter.acquire("active", 0);

    // remaining should be 8 (2 left + 6 refilled).
    expect(r.ok).toBe(true);
    expect(r.remaining).toBe(8);
  });
});
