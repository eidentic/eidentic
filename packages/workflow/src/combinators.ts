import type { Step, StepContext } from "./types.js";
import { checkSignal, isAbortError } from "./step.js";
import { isWorkflowSuspended } from "./suspend.js";
import { assertPositiveSafeInteger, sleepWithSignal } from "./runtime.js";

// ─── chain() ─────────────────────────────────────────────────────────────────

// Single recursive variadic-tuple signature: full inference for ANY number of
// steps (no 8-step cap), with compile-time adjacency checking.
//
// Design (the classic typed-`pipe`/`flow` accumulator):
//
//   - `ChainSteps<Steps>` rebuilds the params tuple into the *expected* tuple,
//     threading each step's OUTPUT type into the next step's INPUT slot. The
//     first step's input is left free (inferred from the call). Each subsequent
//     slot is pinned to `Step<PrevOut, …>`. Constraining the rest param to this
//     computed tuple means: if step i's output isn't assignable to step i+1's
//     declared input, TS reports the mismatch *at argument i+1* (the offending
//     step), because that argument no longer matches its computed expected
//     `Step<PrevOut, …>` shape.
//
//   - `ChainFirstIn<Steps>` / `ChainLastOut<Steps>` extract the exact first
//     input and last output for the returned `Step`. Both read straight off the
//     tuple (no per-step value-level recursion), so they stay exact (never
//     `unknown`) and don't approach the instantiation-depth ceiling — chains of
//     50+ steps compile fine.
//
// Edge cases:
//   - `chain()`        → `Step<unknown, never>` (no steps: nothing to run).
//   - `chain(a)`       → that single step's type, `Step<I, O>`, unchanged.
//   - `chain(a, b, …)` → `Step<FirstIn, LastOut>` with adjacency checked.

/** Any step, used as the structural constraint for the rest param. */
type AnyStep = Step<any, any>;

/** First step's INPUT type (exact). */
type ChainFirstIn<Steps extends readonly AnyStep[]> = Steps extends readonly [
  Step<infer I, any>,
  ...AnyStep[],
]
  ? I
  : unknown;

/** Last step's OUTPUT type (exact). Reads the tail of the tuple directly. */
type ChainLastOut<Steps extends readonly AnyStep[]> = Steps extends readonly [
  ...AnyStep[],
  Step<any, infer O>,
]
  ? O
  : never;

/**
 * Rebuild `Steps` into the *expected* tuple, threading each step's output into
 * the next step's input. `Prev` carries the previous step's output type; the
 * first element keeps its inferred input, every later element is pinned to
 * `Step<Prev, …>`, which is what produces the adjacency type-error at the
 * offending argument.
 */
type ChainSteps<Steps extends readonly AnyStep[], Prev = never> = Steps extends readonly [
  infer Head,
  ...infer Tail,
]
  ? Tail extends readonly AnyStep[]
    ? Head extends Step<infer In, infer Out>
      ? readonly [
          // First slot ([Prev] = [never]) keeps its free input; later slots are
          // constrained to consume the previous step's output `Prev`.
          [Prev] extends [never] ? Step<In, Out> : Step<Prev, Out>,
          ...ChainSteps<Tail, Out>,
        ]
      : readonly [Head, ...ChainSteps<Tail, never>]
    : readonly [Head]
  : readonly [];

export function chain<const Steps extends readonly AnyStep[]>(
  ...steps: Steps & ChainSteps<Steps>
): Step<ChainFirstIn<Steps>, ChainLastOut<Steps>>;
export function chain(...steps: Step<unknown, unknown>[]): Step<unknown, unknown> {
  return async (input: unknown, ctx: StepContext): Promise<unknown> => {
    let current = input;
    for (const s of steps) {
      checkSignal(ctx.signal);
      current = await s(current, ctx);
    }
    return current;
  };
}

// ─── parallel() ──────────────────────────────────────────────────────────────

/**
 * Runs all steps concurrently on the SAME input.
 * Returns a typed object of results, keyed by the same keys as the input map.
 * If any step rejects, the combinator rejects (after all settle) carrying which key failed.
 */
export function parallel<I, T extends Record<string, Step<I, unknown>>>(
  steps: T,
): Step<I, { [K in keyof T]: T[K] extends Step<I, infer O> ? O : never }> {
  return async (
    input: I,
    ctx: StepContext,
  ): Promise<{ [K in keyof T]: T[K] extends Step<I, infer O> ? O : never }> => {
    checkSignal(ctx.signal);
    const keys = Object.keys(steps) as (keyof T)[];
    const entries = await Promise.allSettled(
      keys.map((k) => (steps[k] as Step<I, unknown>)(input, ctx)),
    );
    const result = {} as Record<string, unknown>;
    const errors: Array<{ key: string; error: unknown }> = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      const entry = entries[i]!;
      if (entry.status === "fulfilled") {
        result[k] = entry.value;
      } else {
        errors.push({ key: k, error: entry.reason });
      }
    }
    if (errors.length > 0) {
      const msg = errors.map((e) => `${e.key}: ${e.error instanceof Error ? e.error.message : String(e.error)}`).join("; ");
      const err = new Error(`parallel steps failed — ${msg}`);
      (err as Error & { failedKeys: string[] }).failedKeys = errors.map((e) => e.key);
      throw err;
    }
    return result as { [K in keyof T]: T[K] extends Step<I, infer O> ? O : never };
  };
}

// ─── branch() ────────────────────────────────────────────────────────────────

export function branch<I, O>(
  predicate: (input: I) => boolean | Promise<boolean>,
  ifTrue: Step<I, O>,
  ifFalse: Step<I, O>,
): Step<I, O> {
  return async (input: I, ctx: StepContext): Promise<O> => {
    checkSignal(ctx.signal);
    const cond = await predicate(input);
    checkSignal(ctx.signal);
    return cond ? ifTrue(input, ctx) : ifFalse(input, ctx);
  };
}

// ─── retry() ─────────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Positive safe integer; 1 means no retry. */
  maxAttempts: number;
  /** Positive safe integer delay. Omit for no delay. */
  backoffMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export function retry<I, O>(inner: Step<I, O>, opts: RetryOptions): Step<I, O> {
  assertPositiveSafeInteger(opts.maxAttempts, "retry maxAttempts");
  if (opts.backoffMs !== undefined) {
    assertPositiveSafeInteger(opts.backoffMs, "retry backoffMs");
  }
  const { maxAttempts, backoffMs = 0, shouldRetry } = opts;
  return async (input: I, ctx: StepContext): Promise<O> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        checkSignal(ctx.signal);
        return await inner(input, ctx);
      } catch (err: unknown) {
        // Never retry an AbortError, and never swallow a suspend signal —
        // suspension is normal control flow, not a transient failure.
        if (isAbortError(err) || isWorkflowSuspended(err)) throw err;
        lastErr = err;
        const canRetry = shouldRetry ? shouldRetry(err) : true;
        if (!canRetry || attempt === maxAttempts - 1) break;
        // Backoff with signal check
        if (backoffMs > 0) {
          await sleepWithSignal(backoffMs, ctx.signal);
        }
      }
    }
    throw lastErr;
  };
}

// ─── fallback() ──────────────────────────────────────────────────────────────

export function fallback<I, O>(primary: Step<I, O>, ...fallbacks: Step<I, O>[]): Step<I, O> {
  return async (input: I, ctx: StepContext): Promise<O> => {
    const all = [primary, ...fallbacks];
    let lastErr: unknown;
    for (const s of all) {
      try {
        checkSignal(ctx.signal);
        return await s(input, ctx);
      } catch (err: unknown) {
        // AbortError and suspend signals propagate immediately — do not fall
        // through to the next fallback.
        if (isAbortError(err) || isWorkflowSuspended(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  };
}

// ─── withTimeout() ───────────────────────────────────────────────────────────

/** Wrap a step with a positive-safe-integer timeout in milliseconds. */
export function withTimeout<I, O>(inner: Step<I, O>, ms: number): Step<I, O> {
  assertPositiveSafeInteger(ms, "withTimeout timeoutMs");
  return async (input: I, ctx: StepContext): Promise<O> => {
    checkSignal(ctx.signal);
    const controller = new AbortController();

    // Link parent signal to child controller so parent abort propagates.
    // M20 fix: keep an explicit reference so we can removeEventListener in the
    // finally block — { once } alone only fires on abort; the non-abort path
    // (step completes before timeout and before abort) would otherwise leave the
    // listener registered for the lifetime of the parent signal.
    const onParentAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener("abort", onParentAbort, { once: true });

    const childCtxWithTimeout: StepContext = {
      signal: controller.signal,
      emit: ctx.emit,
      path: ctx.path,
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort(new Error(`step timed out after ${ms}ms`));
        const timeoutErr = new Error(`step timed out after ${ms}ms`);
        timeoutErr.name = "TimeoutError";
        reject(timeoutErr);
      }, ms);
    });

    try {
      const result = await Promise.race([inner(input, childCtxWithTimeout), timeoutPromise]);
      return result;
    } catch (err: unknown) {
      // Re-throw as-is (timeout error, abort error, or inner step error)
      throw err;
    } finally {
      clearTimeout(timeoutId);
      // M20 fix: always remove the parent-signal listener, regardless of which
      // path (success, timeout, parent-abort, inner-error) we exited through.
      ctx.signal?.removeEventListener("abort", onParentAbort);
    }
  };
}

// ─── map() ───────────────────────────────────────────────────────────────────

/**
 * Per-item outcome in `map(..., { errorPolicy: "collect" })`.
 * A discriminated union so callers narrow on `ok` — successes and errors are
 * never mixed into one bare array.
 */
export type MapItemResult<O> =
  | { readonly ok: true; readonly value: O }
  | { readonly ok: false; readonly error: unknown };

/** Error-handling policy for {@link map}. */
export type MapErrorPolicy = "fail-fast" | "collect";

export interface MapOptions {
  /** Positive safe integer max items processed concurrently. Default 4. */
  concurrency?: number;
  /**
   * How to handle item failures.
   *  - `"fail-fast"` (default) — stop scheduling new items on the first
   *    failure and reject with a {@link MapError}. Returns `O[]`.
   *  - `"collect"` — run ALL items regardless of failures and return a
   *    `MapItemResult<O>[]` (discriminated success/error per item). Never
   *    rejects on item failure (still rejects on abort).
   */
  errorPolicy?: MapErrorPolicy;
}

/** Options that select `"collect"` mode (return type narrows to results). */
export interface MapCollectOptions extends MapOptions {
  errorPolicy: "collect";
}

/** Options that select the default `"fail-fast"` mode. */
export interface MapFailFastOptions extends MapOptions {
  errorPolicy?: "fail-fast";
}

/**
 * Thrown by `map()` when one or more items fail.
 * Contains ALL failures (index + original error), not just the first.
 * The `cause` is the first failure's error.
 */
export class MapError extends Error {
  /** All failures in the order they were collected. */
  readonly errors: ReadonlyArray<{ index: number; error: unknown }>;

  constructor(errors: Array<{ index: number; error: unknown }>) {
    const indices = errors.map((e) => e.index).join(", ");
    const firstMsg =
      errors[0]?.error instanceof Error
        ? errors[0].error.message
        : String(errors[0]?.error ?? "unknown error");
    super(`map failed at index ${indices}: ${firstMsg}`, { cause: errors[0]?.error });
    this.name = "MapError";
    this.errors = errors;
  }
}

/**
 * Map an inner step over each element of an array with bounded concurrency.
 *
 * Two modes, selected by `errorPolicy`:
 *  - default `"fail-fast"` → `Step<I[], O[]>` — stops on first failure,
 *    rejects with {@link MapError} (back-compat — unchanged behavior).
 *  - `"collect"` → `Step<I[], MapItemResult<O>[]>` — runs every item and
 *    returns a per-item discriminated result; never rejects on item failure.
 *
 * Order is always preserved (results align with the input array).
 */
export function map<I, O>(inner: Step<I, O>, opts: MapCollectOptions): Step<I[], MapItemResult<O>[]>;
export function map<I, O>(inner: Step<I, O>, opts?: MapFailFastOptions): Step<I[], O[]>;
export function map<I, O>(
  inner: Step<I, O>,
  opts: MapOptions = {},
): Step<I[], O[]> | Step<I[], MapItemResult<O>[]> {
  const concurrency = opts.concurrency ?? 4;
  assertPositiveSafeInteger(concurrency, "map concurrency");
  const policy: MapErrorPolicy = opts.errorPolicy ?? "fail-fast";

  if (policy === "collect") {
    return async (inputs: I[], ctx: StepContext): Promise<MapItemResult<O>[]> => {
      checkSignal(ctx.signal);
      if (inputs.length === 0) return [];

      const results = new Array<MapItemResult<O>>(inputs.length);
      let nextIndex = 0;

      const runNext = async (): Promise<void> => {
        while (nextIndex < inputs.length) {
          // Abort still short-circuits collect mode — cancellation is not an
          // item-level failure, it tears down the whole map.
          checkSignal(ctx.signal);
          const i = nextIndex++;
          try {
            results[i] = { ok: true, value: await inner(inputs[i]!, ctx) };
          } catch (err: unknown) {
            // Propagate abort/suspend; record everything else as an item error.
            if (isAbortError(err) || isWorkflowSuspended(err)) throw err;
            results[i] = { ok: false, error: err };
          }
        }
      };

      const workerCount = Math.min(concurrency, inputs.length);
      const workers: Promise<void>[] = [];
      for (let w = 0; w < workerCount; w++) workers.push(runNext());
      await Promise.all(workers);

      return results;
    };
  }

  return async (inputs: I[], ctx: StepContext): Promise<O[]> => {
    checkSignal(ctx.signal);
    if (inputs.length === 0) return [];

    const results: O[] = new Array<O>(inputs.length);
    // H12 fix: collect ALL failures; earlier code had a single `failure` slot so
    // concurrent workers racing to write it would overwrite each other.
    const failures: Array<{ index: number; error: unknown }> = [];
    let hasFailed = false;
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < inputs.length && !hasFailed) {
        checkSignal(ctx.signal);
        const i = nextIndex++;
        try {
          results[i] = await inner(inputs[i]!, ctx);
        } catch (err: unknown) {
          // Abort/suspend tear down the whole map immediately.
          if (isAbortError(err) || isWorkflowSuspended(err)) throw err;
          // Record this failure; set hasFailed so other workers stop picking up new work.
          failures.push({ index: i, error: err });
          hasFailed = true;
        }
      }
    };

    const workerCount = Math.min(concurrency, inputs.length);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push(runNext());
    }
    // Wait for all workers to drain — a worker that was mid-item when hasFailed
    // was set will finish its current item and may add more failures.
    await Promise.all(workers);

    if (failures.length > 0) {
      // Sort by index so the error message is deterministic.
      failures.sort((a, b) => a.index - b.index);
      throw new MapError(failures);
    }

    return results;
  };
}

// ─── tap() ───────────────────────────────────────────────────────────────────

export function tap<I>(fn: (input: I, ctx: StepContext) => void | Promise<void>): Step<I, I> {
  return async (input: I, ctx: StepContext): Promise<I> => {
    checkSignal(ctx.signal);
    await fn(input, ctx);
    return input;
  };
}
