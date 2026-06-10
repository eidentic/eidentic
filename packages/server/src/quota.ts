import type { QuotaPort, QuotaCheck, QuotaLimits, QuotaUsage } from "@eidentic/types";

/** Token produced by `check` and consumed by `record` or `release` to pair a reservation with its settlement. */
export interface QuotaReservation {
  readonly key: string;
  /** Opaque generation counter — ensures stale tokens from a reset() don't settle against fresh state. */
  readonly generation: number;
  /** Wall-clock timestamp (ms) when the reservation was created — used by the max-age sweep. */
  readonly createdAt: number;
}

/**
 * In-process cumulative quota ledger implementing `QuotaPort` (§20.4) with reserve-on-check /
 * settle-on-record semantics to prevent concurrent requests from bursting past hard caps.
 *
 * Each unique `key` gets an independent usage counter, created lazily on first access.
 *
 * **Reserve-settle protocol (A8)**
 * `check(key)` now also reserves 1 run in an in-flight counter. Ceilings are checked against
 * `committed + reserved`, so concurrent callers that have not yet settled see each other's
 * pending runs. `record(key, spend, reservation)` settles the reservation (replacing the
 * 1-run hold with the actual spend) and increments the committed counter.
 *
 * Callers SHOULD call `record` or `release` after every successful `check` to avoid leaking
 * reservations. The `reservation` token returned on `ok:true` should be stored and passed back.
 * Legacy callers that omit the `reservation` argument to `record` are still supported
 * (backward-compatible): the committed counter increments normally, but the in-flight count
 * is not decremented (they were never reserving anyway).
 *
 * **Max-age sweep (Fix #4 defense-in-depth)**
 * Reservations that are never settled (e.g. the server process crashes mid-run without calling
 * `record`/`release`) would permanently inflate the in-flight counter and eventually block all
 * new runs. A background sweep runs every `reservationMaxAgeMs` (default 5 minutes) and
 * discards any reservation older than that threshold, freeing the leaked slot.
 * Call `destroy()` when shutting down to stop the sweep interval.
 *
 * @note In-memory + unbounded map = v1. Real deployments should back this with a store
 * or Redis. A `reset(key?)` helper is provided for tests and dev tooling.
 *
 * Deferred (v1): storage quotas, monthly-window reset/approval flow,
 * model-downgrade-on-soft, persistent/Redis ledger, USD/token-level reservations
 * (current implementation reserves 1 run; usd/token over-burst under extreme concurrency
 * is bounded to at most `concurrency * limit_per_call`, significantly tighter than without).
 */
export class InMemoryQuota implements QuotaPort {
  private readonly resolve: (key: string) => QuotaLimits;
  private readonly ledger = new Map<string, QuotaUsage>();
  /** In-flight run count per key: incremented on check, decremented on record/release. */
  private readonly reserved = new Map<string, number>();
  /** Per-key monotonic generation counter, bumped on reset() to invalidate outstanding tokens. */
  private readonly generations = new Map<string, number>();
  /** All live reservation tokens, used by the max-age sweep. */
  private readonly activeReservations = new Set<QuotaReservation>();
  /** Max-age sweep interval handle — cleared on destroy(). */
  private readonly sweepInterval: ReturnType<typeof setInterval> | undefined;
  /** How old a reservation must be (ms) before the sweep discards it. Default 5 minutes. */
  private readonly reservationMaxAgeMs: number;

  constructor(
    limits: QuotaLimits | ((key: string) => QuotaLimits),
    options?: {
      /**
       * Maximum age (milliseconds) of an unsettled reservation before the sweep
       * automatically releases it. Defaults to 300_000 (5 minutes).
       * Set to 0 or Infinity to disable the sweep.
       */
      reservationMaxAgeMs?: number;
    },
  ) {
    this.resolve = typeof limits === "function" ? limits : () => limits;
    this.reservationMaxAgeMs = options?.reservationMaxAgeMs ?? 300_000;

    // Start the background sweep only when there is a finite, positive max-age.
    if (this.reservationMaxAgeMs > 0 && isFinite(this.reservationMaxAgeMs)) {
      this.sweepInterval = setInterval(() => {
        this.sweepStaleReservations();
      }, this.reservationMaxAgeMs);
      // Allow the Node.js process to exit even if this interval is still live.
      if (
        typeof this.sweepInterval === "object" &&
        this.sweepInterval !== null &&
        typeof (this.sweepInterval as NodeJS.Timeout).unref === "function"
      ) {
        (this.sweepInterval as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * Release all stale reservations (older than `reservationMaxAgeMs`).
   * Called automatically by the background sweep, but also available for testing.
   */
  sweepStaleReservations(): void {
    const now = Date.now();
    for (const reservation of this.activeReservations) {
      if (now - reservation.createdAt >= this.reservationMaxAgeMs) {
        this.activeReservations.delete(reservation);
        // Only release if the generation still matches (reset() may have invalidated it).
        if (reservation.generation === this.getGeneration(reservation.key)) {
          const cur = this.getReserved(reservation.key);
          if (cur > 0) this.reserved.set(reservation.key, cur - 1);
        }
      }
    }
  }

  /**
   * Stop the background sweep interval. Call this when shutting down to prevent
   * open handle warnings in tests and to release resources cleanly.
   */
  destroy(): void {
    if (this.sweepInterval !== undefined) {
      clearInterval(this.sweepInterval);
    }
  }

  private getUsage(key: string): QuotaUsage {
    let u = this.ledger.get(key);
    if (!u) {
      u = { usd: 0, tokens: 0, runs: 0 };
      this.ledger.set(key, u);
    }
    return u;
  }

  private getGeneration(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private getReserved(key: string): number {
    return this.reserved.get(key) ?? 0;
  }

  /**
   * Check whether `key` may start another run. On success, reserves 1 run in the in-flight
   * counter and returns a `reservation` token. Hard ceilings are checked against
   * `committed + reserved` so concurrent callers see each other's pending runs.
   *
   * Always call `record(key, spend, reservation)` or `release(reservation)` after `check`
   * to free the reservation and prevent in-flight count leakage.
   */
  check(key: string): QuotaCheck & { reservation?: QuotaReservation } {
    const limits = this.resolve(key);
    const usage = this.getUsage(key);
    const inFlight = this.getReserved(key);

    // Hard ceilings: check committed + reserved so concurrent callers see each other.
    if (limits.hardUsd !== undefined && usage.usd >= limits.hardUsd) {
      return { ok: false, reason: `hard USD ceiling reached (${usage.usd} >= ${limits.hardUsd})`, usage };
    }
    if (limits.hardTokens !== undefined && usage.tokens >= limits.hardTokens) {
      return { ok: false, reason: `hard token ceiling reached (${usage.tokens} >= ${limits.hardTokens})`, usage };
    }
    // Runs: count committed + in-flight together to enforce the hard cap under concurrency.
    if (limits.hardRuns !== undefined && usage.runs + inFlight >= limits.hardRuns) {
      return { ok: false, reason: `hard run ceiling reached (${usage.runs + inFlight} >= ${limits.hardRuns})`, usage };
    }

    // Reserve 1 run in the in-flight counter.
    this.reserved.set(key, inFlight + 1);
    const generation = this.getGeneration(key);
    const reservation: QuotaReservation = { key, generation, createdAt: Date.now() };
    this.activeReservations.add(reservation);

    // Soft USD ceiling: warn but allow.
    const warn = limits.softUsd !== undefined && usage.usd >= limits.softUsd;
    return { ok: true, warn: warn || undefined, usage, reservation };
  }

  /**
   * Settle a reservation by recording actual spend. The 1-run reservation is consumed and the
   * committed counter is updated with the real spend. If `reservation` is provided and stale
   * (reset() was called between check and record), the settle is a no-op — no double-counting.
   *
   * Legacy callers that omit `reservation` still have their spend committed (backward-compatible),
   * but the in-flight counter is not decremented (they weren't reserving).
   */
  record(key: string, spend: { usd: number; tokens: number }, reservation?: QuotaReservation): void {
    // Release the in-flight reservation (if still valid for this key).
    if (reservation !== undefined) {
      this.activeReservations.delete(reservation);
      if (reservation.generation === this.getGeneration(key)) {
        const cur = this.getReserved(key);
        if (cur > 0) this.reserved.set(key, cur - 1);
      }
    }
    // Commit the actual spend.
    const usage = this.getUsage(key);
    usage.usd += spend.usd;
    usage.tokens += spend.tokens;
    usage.runs += 1;
  }

  /**
   * Release a reservation WITHOUT recording spend (error / abort path).
   * If the token is stale (reset() was called), this is a no-op.
   */
  release(reservation: QuotaReservation): void {
    this.activeReservations.delete(reservation);
    if (reservation.generation !== this.getGeneration(reservation.key)) return;
    const cur = this.getReserved(reservation.key);
    if (cur > 0) this.reserved.set(reservation.key, cur - 1);
  }

  /**
   * Reset usage counters for a specific key, or ALL keys when called with no argument.
   * Increments the generation counter for affected keys so outstanding reservation tokens
   * become stale and cannot settle against the fresh state.
   * Useful for tests and dev tooling.
   */
  reset(key?: string): void {
    if (key !== undefined) {
      this.ledger.delete(key);
      this.reserved.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      // Remove active reservations for this key (they are now stale).
      for (const r of this.activeReservations) {
        if (r.key === key) this.activeReservations.delete(r);
      }
    } else {
      this.ledger.clear();
      this.reserved.clear();
      for (const k of [...this.generations.keys()]) {
        this.generations.set(k, (this.generations.get(k) ?? 0) + 1);
      }
      this.activeReservations.clear();
    }
  }
}
