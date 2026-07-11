import type { Step, StepContext, StepRetryPolicy, StepTrace } from "./types.js";
import type { ReplayCache } from "./suspend.js";
import { isWorkflowSuspended } from "./suspend.js";
import { assertPositiveSafeInteger, sleepWithSignal } from "./runtime.js";

// ─── Internal interface for trace collector ──────────────────────────────────

/** Internal interface for the trace collector injected by workflow.run(). */
export interface CtxWithCollector extends StepContext {
  _traces?: StepTrace[];
  /** Replay controller for suspend/resume (present only on imperative runs). */
  _replay?: ReplayController;
  /** Resume-lease fence invoked immediately before an uncached effect. */
  _beforeEffect?: () => Promise<void>;
}

// ─── Replay controller ───────────────────────────────────────────────────────

/**
 * Drives deterministic replay for suspend/resume. Lives on the root context and
 * is forwarded (by reference) into child contexts so name→index counters stay
 * coherent across nested steps within a single run.
 *
 * Step results are memoized by `"name#index"` where `index` is the per-name
 * occurrence count within this run. On replay a memoized result is returned
 * without re-invoking the step fn; on a fresh run the result is written into the
 * cache after the fn settles.
 */
export class ReplayController {
  /** Memoized step results + recorded decisions. Mutated as the run progresses. */
  readonly cache: ReplayCache;
  /** Per-name occurrence counters for stable `name#index` keys. */
  private readonly counters = new Map<string, number>();

  constructor(cache: ReplayCache) {
    this.cache = cache;
  }

  /** Allocate the next `"name#index"` key for a step occurrence. */
  nextKey(name: string): string {
    const idx = this.counters.get(name) ?? 0;
    this.counters.set(name, idx + 1);
    return `${name}#${idx}`;
  }

  /** True if a memoized result exists for `key`. */
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cache.steps, key);
  }

  /** Read a memoized step result. */
  get(key: string): unknown {
    return this.cache.steps[key];
  }

  /** Record a fresh step result. */
  set(key: string, value: unknown): void {
    this.cache.steps[key] = value;
  }

  /** True if a decision was recorded for `token`. */
  hasDecision(token: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cache.decisions, token);
  }

  /** Read a recorded suspend decision. */
  decision(token: string): unknown {
    return this.cache.decisions[token];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a child context that appends `name` to the path, forwarding the trace collector and imperative helpers. */
export function childCtx(parent: StepContext, name: string): StepContext {
  const child: CtxWithCollector = {
    signal: parent.signal,
    emit: parent.emit,
    path: [...parent.path, name],
    _traces: (parent as CtxWithCollector)._traces,
    _replay: (parent as CtxWithCollector)._replay,
    _beforeEffect: (parent as CtxWithCollector)._beforeEffect,
    // Forward imperative helpers so nested ctx.step/ctx.all work inside named steps
    step: parent.step,
    all: parent.all,
    suspend: parent.suspend,
  };
  return child;
}

/** Check signal and throw an AbortError if aborted. */
export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err: Error & { name: string } = new Error("AbortError") as Error & { name: string };
    err.name = "AbortError";
    throw err;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}

// ─── step() ──────────────────────────────────────────────────────────────────

/**
 * Names a step so it appears in the trace.
 * Wraps `fn` to emit step.start / step.finish / step.error and record a StepTrace entry.
 *
 * Optional `opts.retry` applies the retry policy inline; the number of
 * invocations is surfaced on the trace entry as `attempts` (omitted when 1).
 *
 * Under suspend/resume the result is memoized by `name + occurrence index`; on
 * replay the fn is NOT re-invoked and no new trace entry is emitted.
 */
export function step<I, O>(name: string, fn: Step<I, O>, opts?: { retry?: StepRetryPolicy }): Step<I, O> {
  if (opts?.retry !== undefined) {
    assertPositiveSafeInteger(opts.retry.maxAttempts, "step retry maxAttempts");
    if (opts.retry.backoffMs !== undefined) {
      assertPositiveSafeInteger(opts.retry.backoffMs, "step retry backoffMs");
    }
  }
  // Snapshot validated scalar options so later caller mutation cannot bypass
  // the construction-time validation.
  const retry = opts?.retry !== undefined ? { ...opts.retry } : undefined;
  return async (input: I, ctx: StepContext): Promise<O> => {
    const path = [...ctx.path, name];

    // ── Replay short-circuit ────────────────────────────────────────────────
    // If a memoized result exists for this occurrence, return it without
    // re-running the fn or re-recording a trace entry. The trace from the
    // original run is reconstructed from the persisted cache by the runner.
    const replay = (ctx as CtxWithCollector)._replay;
    const key = replay?.nextKey(name);
    if (replay !== undefined && key !== undefined && replay.has(key)) {
      return replay.get(key) as O;
    }

    const at = Date.now();
    ctx.emit({ type: "step.start", name, path, at });
    let attempts = 0;
    try {
      checkSignal(ctx.signal);
      await (ctx as CtxWithCollector)._beforeEffect?.();
      checkSignal(ctx.signal);
      const child = childCtx(ctx, name);
      const invoke = (): Promise<O> => {
        attempts++;
        return fn(input, child);
      };
      const result = retry !== undefined ? await runWithRetry(invoke, retry, ctx.signal) : await invoke();

      const durationMs = Date.now() - at;
      const trace: StepTrace = {
        name,
        path,
        startedAt: at,
        durationMs,
        status: "ok",
        ...(attempts > 1 ? { attempts } : {}),
      };
      ctx.emit({ type: "step.finish", name, path, at: Date.now(), durationMs });
      // Attach the trace entry to the context's collector if present
      (ctx as CtxWithCollector)._traces?.push(trace);
      // Memoize for future replays.
      if (replay !== undefined && key !== undefined) replay.set(key, result);
      return result;
    } catch (err: unknown) {
      // A suspend signal is NOT an error: don't record an error trace and don't
      // emit step.error — let it propagate so the runner can persist the cache.
      if (isWorkflowSuspended(err)) throw err;
      const durationMs = Date.now() - at;
      const error = err instanceof Error ? err.message : String(err);
      const trace: StepTrace = {
        name,
        path,
        startedAt: at,
        durationMs,
        status: "error",
        error,
        ...(attempts > 1 ? { attempts } : {}),
      };
      ctx.emit({ type: "step.error", name, path, at: Date.now(), durationMs, error });
      (ctx as CtxWithCollector)._traces?.push(trace);
      throw err;
    }
  };
}

// ─── inline retry (shared with the retry() combinator semantics) ─────────────

/**
 * Run `invoke` up to `policy.maxAttempts` times with optional backoff. Mirrors
 * the `retry()` combinator: never retries an AbortError or a suspend signal,
 * honors `shouldRetry`, and rethrows the last error after exhausting attempts.
 */
async function runWithRetry<O>(
  invoke: () => Promise<O>,
  policy: StepRetryPolicy,
  signal: AbortSignal | undefined,
): Promise<O> {
  const { maxAttempts, backoffMs = 0, shouldRetry } = policy;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      checkSignal(signal);
      return await invoke();
    } catch (err: unknown) {
      if (isAbortError(err) || isWorkflowSuspended(err)) throw err;
      lastErr = err;
      const canRetry = shouldRetry ? shouldRetry(err) : true;
      if (!canRetry || attempt === maxAttempts - 1) break;
      if (backoffMs > 0) await sleepWithSignal(backoffMs, signal);
    }
  }
  throw lastErr;
}
