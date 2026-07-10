// ─── Core step type ──────────────────────────────────────────────────────────

/**
 * A typed async function from I → O. The basic unit of composition.
 * All combinators take and return `Step<I,O>`, so everything nests freely.
 */
export type Step<I, O> = (input: I, ctx: StepContext) => Promise<O>;

// ─── Per-step retry policy ───────────────────────────────────────────────────

/** Per-step retry policy (mirrors the `retry()` combinator's options). */
export interface StepRetryPolicy {
  /** Positive safe integer maximum number of attempts (1 = no retry). */
  maxAttempts: number;
  /** Positive safe integer delay between attempts in ms. Omit for no delay. */
  backoffMs?: number;
  /** Predicate deciding whether a given error is retryable. Default: always. */
  shouldRetry?: (err: unknown) => boolean;
}

/** Options accepted by `.step(...)` (builder) and `ctx.step(...)` (imperative). */
export interface StepRunOptions {
  /**
   * Wrap the step in retry semantics. Attempts are surfaced on the step's
   * trace entry as `attempts` (count of invocations before it settled).
   */
  retry?: StepRetryPolicy;
}

// ─── Execution context ───────────────────────────────────────────────────────

/** Per-execution context threaded through every step. */
export interface StepContext {
  /** Cooperative cancellation. Steps should check this before/after I/O. */
  signal?: AbortSignal;
  /** Push a custom event into the workflow trace. */
  emit(event: WorkflowEvent): void;
  /** Nested step-name path (outermost → innermost) for tracing. */
  readonly path: readonly string[];

  /**
   * Run a named thunk or Step and record it in the trace (imperative escape-hatch).
   * Overload 1: thunk  — `ctx.step("name", () => Promise<O>): Promise<O>`
   * Overload 2: Step   — `ctx.step("name", s, input): Promise<O>`
   *
   * Each overload accepts optional {@link StepRunOptions} (per-step retry) as a
   * trailing argument. Under suspend/resume the step result is memoized by
   * `name + occurrence index`; on replay the fn is NOT re-invoked.
   *
   * Only available inside `workflow(name, body)` imperative bodies.
   */
  step?: {
    <O>(name: string, fn: () => Promise<O>, opts?: StepRunOptions): Promise<O>;
    <I, O>(name: string, s: Step<I, O>, input: I, opts?: StepRunOptions): Promise<O>;
  };

  /**
   * Suspend the run for a human-in-the-loop decision (replay-based HITL).
   *
   * On first reach with no recorded decision for `token`, throws a
   * `WorkflowSuspended` control-flow signal carrying `payload` and the replay
   * cache; the run is persisted with a suspended lifecycle. `resumeWorkflow()`
   * re-executes the body, replaying memoized step results, and resolves this
   * gate with the supplied decision typed as `T`.
   *
   * DETERMINISM: code before a `suspend` re-runs on resume — keep side effects
   * inside `ctx.step(...)`. See the suspend module docs.
   *
   * Only available inside `workflow(name, body)` imperative bodies.
   */
  suspend?: <T = unknown>(token: string, payload?: unknown) => Promise<T>;

  /**
   * Run a record of thunks concurrently and return a typed result object.
   * Mirrors `parallel()` for the imperative style.
   *
   * Only available inside `workflow(name, body)` imperative bodies.
   */
  all?: <T extends Record<string, () => Promise<unknown>>>(
    thunks: T,
  ) => Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: "step.start"; name: string; path: string[]; at: number }
  | { type: "step.finish"; name: string; path: string[]; at: number; durationMs: number }
  | { type: "step.error"; name: string; path: string[]; at: number; durationMs: number; error: string }
  | { type: "custom"; name: string; data?: unknown; at: number };

// ─── Trace ───────────────────────────────────────────────────────────────────

export interface StepTrace {
  name: string;
  path: string[];
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  /**
   * Number of times the step body was invoked before it settled.
   * Present (and `> 1`) only when the step ran under a retry policy and
   * actually retried; absent for single-attempt steps (back-compat — a plain
   * step trace never carries this field).
   */
  attempts?: number;
}

// ─── Workflow result ─────────────────────────────────────────────────────────

export interface WorkflowResult<O> {
  output: O;
  trace: StepTrace[];
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface Workflow<I, O> {
  name: string;
  /** Optional version tag, recorded on every run via the registry. */
  version?: string;
  run(
    input: I,
    opts?: { signal?: AbortSignal; onEvent?: (e: WorkflowEvent) => void },
  ): Promise<WorkflowResult<O>>;
  /** Use this workflow as a `Step` so it can be composed into other workflows. */
  asStep(): Step<I, O>;
}
