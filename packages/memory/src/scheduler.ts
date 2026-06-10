import { scopeKey, type Scope, type Usage } from "@eidentic/types";
import type { Consolidator, ConsolidationResult } from "./consolidate.js";
import type { Memory, DedupeOptions, DedupeResult } from "./memory.js";

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** Aggregated outcome of one maintenance pass — `usage` is meant for cost.background (§6.5). */
export interface MaintenanceResult {
  /** Distillation result (facts learned this pass). */
  distillation: ConsolidationResult;
  /** Number of TTL-expired facts invalidated this pass. */
  swept: number;
  /** Number of archival passages merged away this pass. */
  merged: number;
  /** Sum of distillation usage + dedupe usage (sweep adds none). Account to cost.background. */
  usage: Usage;
}

export interface ConsolidationSchedulerOptions {
  /** The distillation consolidator (Plan 7b). Required. */
  consolidator: Consolidator;
  /** A Memory instance for the maintenance ops (sweep + dedupe). Required. */
  memory: Memory;
  /** When set, each pass also runs `memory.deduplicateArchival(scope, dedupe)`. Omit to skip dedup. */
  dedupe?: DedupeOptions;
  /**
   * Per-scope distillation source resolver. Called once per pass to obtain the conversation to
   * distill for THIS scope — either raw `text`, or a `sessionId` whose events the consolidator
   * reads from the store. Without it (or when it returns neither), `consolidate` short-circuits
   * with zero facts / zero usage: distillation becomes a no-op and the pass only sweeps + dedupes.
   * Production deployments distilling live conversations MUST supply this (the in-process scheduler
   * has no other way to know each scope's source).
   */
  source?: (scope: Scope) => { text?: string; sessionId?: string } | Promise<{ text?: string; sessionId?: string }>;
  /**
   * Static source text passed to consolidate for EVERY scope/pass. Convenience for single-scope or
   * test use; `source` takes precedence when both are set. Note: a fixed string distilled identically
   * across scopes is rarely what production wants — prefer `source`.
   */
  text?: string;
  /** Injectable clock (ISO) — used for the staleness sweep `now`. */
  now?: () => string;
}

/**
 * In-process single-flight + debounce scheduler for memory consolidation (§9.8). Guarantees only
 * ONE maintenance pass runs per scope at a time; a `schedule` arriving while a pass is running for
 * that scope coalesces into a SINGLE follow-up pass (not N). Distinct scopes run independently.
 *
 * This is the IN-PROCESS form; the durable background-job queue (§9, restart-survival, dead-letter)
 * is deferred to a later plan. Deterministic/testable: no real timers — passes run on `schedule`/
 * `runNow`; the clock is injectable.
 */
export class ConsolidationScheduler {
  private readonly running = new Map<string, Promise<MaintenanceResult>>();
  private readonly queued = new Set<string>();

  constructor(private readonly opts: ConsolidationSchedulerOptions) {}

  /**
   * Single-flight: if a pass for `scope` is already running, mark a follow-up and return the
   * in-flight promise (coalescing); otherwise start one.
   */
  schedule(scope: Scope): Promise<MaintenanceResult> {
    const k = scopeKey(scope);
    const inFlight = this.running.get(k);
    if (inFlight) {
      this.queued.add(k); // coalesce: at most ONE follow-up
      return inFlight;
    }
    const run = this.runNow(scope).finally(() => {
      this.running.delete(k);
      if (this.queued.delete(k)) {
        // exactly one coalesced follow-up; its promise has no external consumer (the coalesced
        // callers already received THIS pass's promise), so swallow its rejection to avoid an
        // unhandledRejection — the follow-up's outcome is observable via a fresh schedule()/runNow().
        void this.schedule(scope).catch(() => {});
      }
    });
    this.running.set(k, run);
    return run;
  }

  /**
   * Run one maintenance pass NOW (bypasses single-flight): distillation + staleness sweep +
   * (optional) archival dedup. Aggregates distillation + dedupe usage into `usage`.
   */
  async runNow(scope: Scope): Promise<MaintenanceResult> {
    const now = this.opts.now?.() ?? new Date().toISOString();
    const src = this.opts.source ? await this.opts.source(scope) : { text: this.opts.text };
    const distillation = await this.opts.consolidator.consolidate({ scope, ...src });
    const swept = await this.opts.memory.sweepExpiredFacts(scope, now);
    let dedupe: DedupeResult = { merged: 0, usage: { ...ZERO_USAGE } };
    if (this.opts.dedupe) {
      dedupe = await this.opts.memory.deduplicateArchival(scope, this.opts.dedupe);
    }
    const usage = addUsage(distillation.usage, dedupe.usage);
    return { distillation, swept, merged: dedupe.merged, usage };
  }
}
