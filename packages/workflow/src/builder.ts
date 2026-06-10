import type { Step, StepContext, StepRunOptions, Workflow, WorkflowResult, WorkflowEvent } from "./types.js";
import { chain, branch as branchCombinator, parallel as parallelCombinator, map as mapCombinator, tap as tapCombinator } from "./combinators.js";
import type { MapCollectOptions, MapFailFastOptions, MapItemResult, MapOptions } from "./combinators.js";
import { step as stepWrapper } from "./step.js";
import { makeWorkflow, type WorkflowMeta } from "./workflow-internal.js";

// ─── WorkflowBuilder ─────────────────────────────────────────────────────────
//
// A fluent, fully type-inferred builder that compiles down to `chain()`.
// All methods return a NEW builder — no shared mutable state.
//
// Type parameters:
//   In  — the workflow input type (fixed by the first `.step()` call)
//   Cur — the current output type (threaded through each combinator)

/**
 * The entry-point returned by `workflow(name)` (no body argument).
 * The first `.step()` call pins the input type `A`.
 */
export interface WorkflowStart {
  /** Add the first step. Pins the input type `A` and initial output `B`. */
  step<A, B>(s: Step<A, B>): WorkflowBuilder<A, B>;
  /**
   * Named variant — wraps the step so it appears in the trace under `name`.
   * Pass `opts.retry` to apply a per-step retry policy (attempts surface on the
   * trace entry).
   */
  step<A, B>(name: string, s: Step<A, B>, opts?: StepRunOptions): WorkflowBuilder<A, B>;
}

/**
 * Chainable builder — threads `In` (fixed) and `Cur` (running output type).
 *
 * `retry`, `fallback`, and `withTimeout` are NOT builder methods — wrap the
 * individual step you pass in:
 *   `.step(retry(agentStep(x), { maxAttempts: 2 }))`
 */
export interface WorkflowBuilder<In, Cur> extends Workflow<In, Cur> {
  /** Append a step. Threads Cur → Next. */
  step<Next>(s: Step<Cur, Next>): WorkflowBuilder<In, Next>;
  /**
   * Named variant. Pass `opts.retry` to wrap the step in a per-step retry
   * policy; the attempt count surfaces on the trace entry as `attempts`.
   */
  step<Next>(name: string, s: Step<Cur, Next>, opts?: StepRunOptions): WorkflowBuilder<In, Next>;

  /** Branch on a predicate. Both arms must return the same type `Next`. */
  branch<Next>(
    pred: (c: Cur) => boolean | Promise<boolean>,
    ifTrue: Step<Cur, Next>,
    ifFalse: Step<Cur, Next>,
  ): WorkflowBuilder<In, Next>;

  /**
   * Run a record of steps concurrently on the current value.
   * Returns a typed object of results.
   */
  parallel<T extends Record<string, Step<Cur, unknown>>>(
    steps: T,
  ): WorkflowBuilder<In, { [K in keyof T]: T[K] extends Step<Cur, infer O> ? O : never }>;

  /**
   * Map an inner step over each element of the current array.
   * Only callable when `Cur` is an array type (enforced via `this` typing).
   *
   * `errorPolicy: "collect"` runs every item and yields `MapItemResult<O>[]`
   * (discriminated success/error per item); the default `"fail-fast"` yields
   * `O[]`. The two modes have distinct, correctly-inferred return types.
   *
   * @example `.map(agentStep(processor), { concurrency: 4 })`
   * @example `.map(risky, { errorPolicy: "collect" })` // → MapItemResult<O>[]
   */
  map<E, O>(
    this: WorkflowBuilder<In, E[]>,
    inner: Step<E, O>,
    opts: MapCollectOptions,
  ): WorkflowBuilder<In, MapItemResult<O>[]>;
  map<E, O>(
    this: WorkflowBuilder<In, E[]>,
    inner: Step<E, O>,
    opts?: MapFailFastOptions,
  ): WorkflowBuilder<In, O[]>;

  /** Run a side-effect function without changing the value. */
  tap(fn: (c: Cur, ctx: StepContext) => void | Promise<void>): WorkflowBuilder<In, Cur>;

  // ── Terminal operations ───────────────────────────────────────────────────

  /** Convert the builder to a plain `Step<In, Cur>` for nesting. */
  asStep(): Step<In, Cur>;

  /** Return the underlying `Workflow<In, Cur>`. */
  build(): Workflow<In, Cur>;

  /** Run the workflow. */
  run(
    input: In,
    opts?: { signal?: AbortSignal; onEvent?: (e: WorkflowEvent) => void },
  ): Promise<WorkflowResult<Cur>>;
}

// ─── Internal builder class ───────────────────────────────────────────────────

class Builder<In, Cur> implements WorkflowBuilder<In, Cur> {
  readonly name: string;
  readonly version?: string;

  // The composed step so far (typed as Step<unknown,unknown> to avoid casting noise)
  private readonly _composed: Step<unknown, unknown>;
  private readonly _meta: WorkflowMeta | undefined;

  constructor(name: string, composed: Step<unknown, unknown>, meta?: WorkflowMeta) {
    this.name = name;
    this._composed = composed;
    this._meta = meta;
    if (meta?.version !== undefined) this.version = meta.version;
  }

  // Helper: produce a new builder that appends `nextStep` via chain
  private _next<Next>(nextStep: Step<unknown, unknown>): Builder<In, Next> {
    return new Builder<In, Next>(
      this.name,
      chain(this._composed, nextStep) as Step<unknown, unknown>,
      this._meta,
    );
  }

  // Lazy access to the underlying Workflow (avoids recreating on every call)
  private _wf(): Workflow<In, Cur> {
    return makeWorkflow(this.name, this._composed as Step<In, Cur>, this._meta);
  }

  // ── step ──────────────────────────────────────────────────────────────────

  step<Next>(
    nameOrStep: string | Step<Cur, Next>,
    maybeStep?: Step<Cur, Next>,
    opts?: StepRunOptions,
  ): WorkflowBuilder<In, Next> {
    if (typeof nameOrStep === "string") {
      const s = maybeStep!;
      const wrapped = stepWrapper(
        nameOrStep,
        s as Step<unknown, unknown>,
        opts?.retry !== undefined ? { retry: opts.retry } : undefined,
      );
      return this._next<Next>(wrapped as Step<unknown, unknown>);
    }
    return this._next<Next>(nameOrStep as Step<unknown, unknown>);
  }

  // ── branch ────────────────────────────────────────────────────────────────

  branch<Next>(
    pred: (c: Cur) => boolean | Promise<boolean>,
    ifTrue: Step<Cur, Next>,
    ifFalse: Step<Cur, Next>,
  ): WorkflowBuilder<In, Next> {
    const b = branchCombinator(
      pred as (input: unknown) => boolean | Promise<boolean>,
      ifTrue as Step<unknown, Next>,
      ifFalse as Step<unknown, Next>,
    );
    return this._next<Next>(b as Step<unknown, unknown>);
  }

  // ── parallel ──────────────────────────────────────────────────────────────

  parallel<T extends Record<string, Step<Cur, unknown>>>(
    steps: T,
  ): WorkflowBuilder<In, { [K in keyof T]: T[K] extends Step<Cur, infer O> ? O : never }> {
    type Out = { [K in keyof T]: T[K] extends Step<Cur, infer O> ? O : never };
    const p = parallelCombinator(steps as Record<string, Step<unknown, unknown>>);
    // The cast to `any` breaks the recursive type cycle that TypeScript cannot resolve.
    // Safety: parallelCombinator<I,T> returns Step<I, {[K]: T[K] output}> which is exactly Out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this._next<Out>(p as Step<unknown, unknown>) as any;
  }

  // ── map ───────────────────────────────────────────────────────────────────

  map<E, O>(
    this: Builder<In, E[]>,
    inner: Step<E, O>,
    opts?: MapOptions,
  ): WorkflowBuilder<In, O[]> {
    // The builder threads an erased Step internally; the precise per-mode return
    // type (O[] vs MapItemResult<O>[]) is preserved by the public interface
    // overloads on `WorkflowBuilder.map`. Use the fail-fast overload internally —
    // runtime behavior is driven entirely by `opts.errorPolicy`.
    const m = mapCombinator(inner as Step<unknown, unknown>, opts as MapFailFastOptions);
    return this._next<O[]>(m as Step<unknown, unknown>);
  }

  // ── tap ───────────────────────────────────────────────────────────────────

  tap(fn: (c: Cur, ctx: StepContext) => void | Promise<void>): WorkflowBuilder<In, Cur> {
    const t = tapCombinator(fn as (input: unknown, ctx: StepContext) => void | Promise<void>);
    return this._next<Cur>(t as Step<unknown, unknown>);
  }

  // ── terminal ──────────────────────────────────────────────────────────────

  asStep(): Step<In, Cur> {
    return this._wf().asStep();
  }

  build(): Workflow<In, Cur> {
    return this._wf();
  }

  run(
    input: In,
    opts?: { signal?: AbortSignal; onEvent?: (e: WorkflowEvent) => void },
  ): Promise<WorkflowResult<Cur>> {
    return this._wf().run(input, opts);
  }
}

// ─── WorkflowStart implementation ────────────────────────────────────────────

class Start implements WorkflowStart {
  constructor(private readonly _name: string, private readonly _meta?: WorkflowMeta) {}

  step<A, B>(
    nameOrStep: string | Step<A, B>,
    maybeStep?: Step<A, B>,
    opts?: StepRunOptions,
  ): WorkflowBuilder<A, B> {
    if (typeof nameOrStep === "string") {
      const wrapped = stepWrapper(
        nameOrStep,
        maybeStep! as Step<unknown, unknown>,
        opts?.retry !== undefined ? { retry: opts.retry } : undefined,
      );
      return new Builder<A, B>(this._name, wrapped as Step<unknown, unknown>, this._meta);
    }
    return new Builder<A, B>(this._name, nameOrStep as Step<unknown, unknown>, this._meta);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createWorkflowStart(name: string, meta?: WorkflowMeta): WorkflowStart {
  return new Start(name, meta);
}
