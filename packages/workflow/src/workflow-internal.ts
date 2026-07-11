import type {
  Step,
  StepContext,
  StepRunOptions,
  StepTrace,
  Workflow,
  WorkflowEvent,
  WorkflowResult,
} from "./types.js";
import { type CtxWithCollector, ReplayController, step as tracedStep } from "./step.js";
import {
  type ReplayCache,
  WorkflowSuspended,
  emptyReplayCache,
  isWorkflowSuspended,
} from "./suspend.js";

// ─── WorkflowRunError ─────────────────────────────────────────────────────────

/**
 * Thrown by `workflow.run()` when the workflow body throws.
 * Wraps the original error and includes the partial step trace recorded
 * up to the point of failure.
 */
export class WorkflowRunError extends Error {
  /** The original error thrown by the workflow body. */
  override cause: unknown;
  /** Human-readable name of the workflow that failed. */
  readonly workflowName: string;
  /** Partial step trace recorded up to the point of failure. */
  readonly trace: StepTrace[];

  constructor(workflowName: string, cause: unknown, trace: StepTrace[]) {
    const msg =
      cause instanceof Error
        ? `Workflow "${workflowName}" failed: ${cause.message}`
        : `Workflow "${workflowName}" failed`;
    super(msg, { cause });
    this.name = "WorkflowRunError";
    this.cause = cause;
    this.workflowName = workflowName;
    this.trace = trace;
  }
}

// ─── makeWorkflow() ───────────────────────────────────────────────────────────

/** Optional definition-level metadata shared by all workflow factories. */
export interface WorkflowMeta {
  /** Optional version tag recorded on every run of this workflow. */
  version?: string;
}

/**
 * Symbol under which the raw body `Step<I,O>` is stashed on a workflow object,
 * so `resumeWorkflow()` can re-execute it for deterministic replay. Stored
 * non-enumerably so it never leaks into JSON / `Object.keys`.
 */
const BODY = Symbol("eidentic.workflow.body");

/** Retrieve the replayable body of a workflow (or `undefined` if absent). */
export function getWorkflowBody<I, O>(wf: Workflow<I, O>): Step<I, O> | undefined {
  return (wf as unknown as { [BODY]?: Step<I, O> })[BODY];
}

/**
 * Internal factory used by both `workflow()` and the fluent builder.
 * Builds the root StepContext (trace collector + ctx.step / ctx.all / ctx.suspend)
 * and returns a full `Workflow<I,O>`.
 */
export function makeWorkflow<I, O>(name: string, body: Step<I, O>, meta?: WorkflowMeta): Workflow<I, O> {
  const version = meta?.version;
  const wf: Workflow<I, O> = {
    name,
    ...(version !== undefined ? { version } : {}),

    async run(
      input: I,
      opts?: { signal?: AbortSignal; onEvent?: (e: WorkflowEvent) => void },
    ): Promise<WorkflowResult<O>> {
      const exec = await executeBody(name, body, input, opts);
      if (exec.kind === "suspended") {
        // A suspend escaped to the top level via `run()`. Surface it as the
        // signal so the caller (or a registry adapter) can persist + resume.
        throw exec.signal;
      }
      return { output: exec.output, trace: exec.trace };
    },

    asStep(): Step<I, O> {
      return async (input: I, ctx: StepContext): Promise<O> => {
        const child = buildChildCtx(ctx, name);
        return body(input, child);
      };
    },
  };

  // Stash the raw body (non-enumerable) so resumeWorkflow() can replay it.
  Object.defineProperty(wf, BODY, { value: body, enumerable: false, writable: false });

  return wf;
}

// ─── Body execution (shared by run() and resumeWorkflow()) ────────────────────

/** Result of executing a workflow body once. */
export type BodyExecution<O> =
  | { kind: "completed"; output: O; trace: StepTrace[] }
  | { kind: "suspended"; signal: WorkflowSuspended; trace: StepTrace[] };

/**
 * Execute `body` once with a fresh root context, optionally seeding a replay
 * cache (for resume). Translates a thrown {@link WorkflowSuspended} into a
 * `"suspended"` execution; rewraps other throws in {@link WorkflowRunError}.
 */
export async function executeBody<I, O>(
  name: string,
  body: Step<I, O>,
  input: I,
  opts?: {
    signal?: AbortSignal;
    onEvent?: (e: WorkflowEvent) => void;
    cache?: ReplayCache;
    beforeEffect?: () => Promise<void>;
  },
): Promise<BodyExecution<O>> {
  const traces: StepTrace[] = [];
  const cache = opts?.cache ?? emptyReplayCache();
  const ctx = buildRootCtx(opts?.signal, traces, opts?.onEvent, cache, opts?.beforeEffect);
  try {
    await opts?.beforeEffect?.();
    const output = await body(input, ctx);
    return { kind: "completed", output, trace: traces };
  } catch (err: unknown) {
    if (isWorkflowSuspended(err)) {
      // Surface the suspend with the live partial trace + cache snapshot.
      const signal =
        err instanceof WorkflowSuspended
          ? new WorkflowSuspended(err.token, err.payload, traces, cache)
          : (err as WorkflowSuspended);
      return { kind: "suspended", signal, trace: traces };
    }
    // Re-wrap in WorkflowRunError so callers can inspect the partial trace
    // and the original cause. If already a WorkflowRunError (nested workflow),
    // rethrow as-is to preserve the innermost context.
    if (err instanceof WorkflowRunError) throw err;
    throw new WorkflowRunError(name, err, traces);
  }
}

// ─── Context builders ─────────────────────────────────────────────────────────

/** Build the root StepContext for `run()`. Populates ctx.step / ctx.all / ctx.suspend. */
export function buildRootCtx(
  signal: AbortSignal | undefined,
  traces: StepTrace[],
  onEvent: ((e: WorkflowEvent) => void) | undefined,
  cache: ReplayCache,
  beforeEffect?: () => Promise<void>,
): CtxWithCollector {
  const ctx: CtxWithCollector = {
    signal,
    path: [],
    _traces: traces,
    _replay: new ReplayController(cache),
    ...(beforeEffect !== undefined ? { _beforeEffect: beforeEffect } : {}),
    emit(event: WorkflowEvent): void {
      onEvent?.(event);
    },
    step: undefined,
    all: undefined,
    suspend: undefined,
  };
  ctx.step = makeCtxStep(ctx);
  ctx.all = makeCtxAll(ctx);
  ctx.suspend = makeCtxSuspend(ctx);
  return ctx;
}

/** Build a child context that nests `name` into the path (used by asStep()). */
export function buildChildCtx(parent: StepContext, name: string): CtxWithCollector {
  const child: CtxWithCollector = {
    signal: parent.signal,
    path: [...parent.path, name],
    _traces: (parent as CtxWithCollector)._traces,
    _replay: (parent as CtxWithCollector)._replay,
    _beforeEffect: (parent as CtxWithCollector)._beforeEffect,
    emit: parent.emit,
    step: undefined,
    all: undefined,
    suspend: undefined,
  };
  child.step = makeCtxStep(child);
  child.all = makeCtxAll(child);
  child.suspend = makeCtxSuspend(child);
  return child;
}

// ─── ctx.step implementation ──────────────────────────────────────────────────

const _SENTINEL = Symbol("no-input");

function makeCtxStep(ctx: StepContext): NonNullable<StepContext["step"]> {
  function ctxStep<O>(name: string, fn: () => Promise<O>, opts?: StepRunOptions): Promise<O>;
  function ctxStep<I, O>(name: string, s: Step<I, O>, input: I, opts?: StepRunOptions): Promise<O>;
  function ctxStep(
    name: string,
    fnOrStep: (() => Promise<unknown>) | Step<unknown, unknown>,
    inputOrOpts: unknown = _SENTINEL,
    maybeOpts?: StepRunOptions,
  ): Promise<unknown> {
    // Disambiguate the trailing-opts position:
    //  - thunk overload: ctxStep(name, fn, opts?)         → input slot holds opts
    //  - step  overload: ctxStep(name, s, input, opts?)   → opts in 4th slot
    // A thunk takes no positional input, so when the 3rd arg is the options
    // object (and there's no 4th arg) we treat it as the thunk's opts.
    let input: unknown = inputOrOpts;
    let opts: StepRunOptions | undefined = maybeOpts;
    const thirdIsOpts = isStepRunOptions(inputOrOpts) && maybeOpts === undefined && fnOrStep.length === 0;
    if (thirdIsOpts) {
      opts = inputOrOpts as StepRunOptions;
      input = _SENTINEL;
    }

    const isStep = input !== _SENTINEL;
    const asStep: Step<unknown, unknown> = isStep
      ? // Step<I,O> call: pass input through
        (fnOrStep as Step<unknown, unknown>)
      : // Thunk call: ignore input, just invoke the thunk
        async (_i: unknown) => (fnOrStep as () => Promise<unknown>)();

    // Delegate to the same tracedStep() used by the declarative path — this is
    // where replay memoization, trace recording, and per-step retry happen.
    return tracedStep(name, asStep, opts?.retry !== undefined ? { retry: opts.retry } : undefined)(
      isStep ? input : undefined,
      ctx,
    );
  }
  return ctxStep as NonNullable<StepContext["step"]>;
}

/** Heuristic: is this value a {@link StepRunOptions} bag (i.e. has a `retry` key)? */
function isStepRunOptions(v: unknown): v is StepRunOptions {
  return typeof v === "object" && v !== null && "retry" in (v as Record<string, unknown>);
}

// ─── ctx.suspend implementation ───────────────────────────────────────────────

function makeCtxSuspend(ctx: StepContext): NonNullable<StepContext["suspend"]> {
  return async function ctxSuspend<T = unknown>(token: string, payload?: unknown): Promise<T> {
    const replay = (ctx as CtxWithCollector)._replay;
    // On replay, if a decision was recorded for this token, resolve with it
    // instead of suspending again — this is how multiple sequential suspends
    // work (each resume replays past decisions too).
    if (replay !== undefined && replay.hasDecision(token)) {
      return replay.decision(token) as T;
    }
    // No decision yet → suspend. Throw the control-flow signal; the runner
    // converts it into a persisted suspended run carrying the cache so far.
    const cache = replay?.cache ?? emptyReplayCache();
    throw new WorkflowSuspended(token, payload, [], cache);
  };
}

// ─── ctx.all implementation ───────────────────────────────────────────────────

function makeCtxAll(ctx: StepContext): NonNullable<StepContext["all"]> {
  return async function ctxAll<T extends Record<string, () => Promise<unknown>>>(
    thunks: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    // Pre-dispatch abort check — reject immediately if already aborted.
    if (ctx.signal?.aborted) {
      return Promise.reject(makeAbortError(ctx.signal.reason));
    }

    const keys = Object.keys(thunks) as (keyof T)[];

    // Build a promise that rejects as soon as the parent signal fires, so
    // ctx.all settles promptly on abort without trying to cancel in-flight thunks.
    // We keep a named handler reference so we can removeEventListener in finally.
    const signal = ctx.signal;
    let abortHandler: (() => void) | undefined;
    const abortPromise: Promise<never> | null = signal
      ? new Promise<never>((_, reject) => {
          abortHandler = () => reject(makeAbortError(signal.reason));
          signal.addEventListener("abort", abortHandler, { once: true });
        })
      : null;

    const thunkPromises = keys.map((k) => {
      // Per-thunk pre-dispatch check so we skip submission if signal already fired
      // while we were iterating (shouldn't happen given the pre-check above, but
      // guards against races in microtask scheduling).
      if (signal?.aborted) {
        return Promise.reject(makeAbortError(signal.reason));
      }
      return thunks[k]!();
    });

    let settled: PromiseSettledResult<unknown>[];
    try {
      if (abortPromise !== null) {
        // Race each thunk against the abort signal. If abort fires we reject
        // immediately; the thunk promises continue running but their results
        // are ignored (can't force-cancel user code).
        settled = await Promise.allSettled(
          thunkPromises.map((p) => Promise.race([p, abortPromise])),
        );
      } else {
        settled = await Promise.allSettled(thunkPromises);
      }
    } finally {
      // Remove the abort listener if it was added (clean up, even though { once }
      // handles the fire case — this covers the non-fired path too).
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", abortHandler);
      }
    }

    const result = {} as Record<string, unknown>;
    const errors: Array<{ key: string; error: unknown }> = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      const entry = settled[i]!;
      if (entry.status === "fulfilled") {
        result[k] = entry.value;
      } else {
        errors.push({ key: k, error: entry.reason });
      }
    }
    if (errors.length > 0) {
      // A suspend signal inside a concurrent thunk propagates as a suspend.
      const suspendEntry = errors.find((e) => isWorkflowSuspended(e.error));
      if (suspendEntry !== undefined) throw suspendEntry.error;
      // If any error is an abort error, propagate it directly (don't wrap).
      const abortEntry = errors.find((e) => isAbortLike(e.error));
      if (abortEntry !== undefined) throw abortEntry.error;

      const msg = errors
        .map((e) => `${e.key}: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
        .join("; ");
      throw new Error(`ctx.all failed — ${msg}`);
    }
    return result as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
  };
}

function makeAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error("AbortError") as Error & { name: string };
  err.name = "AbortError";
  return err;
}

function isAbortLike(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR")
  );
}
