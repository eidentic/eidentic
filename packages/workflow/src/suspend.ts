// ─── Suspend / human-in-the-loop (replay-based) ──────────────────────────────
//
// Suspend/resume is implemented with **deterministic replay** — the same
// contract every replay-based durable-execution engine uses (Temporal,
// DBOS, Restate, …). Workflow bodies are arbitrary JavaScript, so we cannot
// serialize a paused stack. Instead, on resume we re-run the body from the
// top, replaying the recorded results of already-completed `ctx.step(...)`
// calls (memoized by name + occurrence index) WITHOUT re-invoking their
// functions, and feeding stored decisions into the matching `ctx.suspend(...)`
// gates.
//
// ╭──────────────────────────────────────────────────────────────────────────╮
// │ DETERMINISM CONTRACT (read this loudly)                                   │
// │                                                                           │
// │ Code that runs BEFORE a `ctx.suspend(...)` gate MUST be deterministic     │
// │ with respect to replay. On resume the body re-executes from the start;    │
// │ any logic outside `ctx.step(...)` runs again. Therefore:                  │
// │                                                                           │
// │   • Put every side effect (network calls, DB writes, randomness, clock    │
// │     reads, agent calls) INSIDE `ctx.step(name, fn)` so its result is      │
// │     memoized and the fn is NOT re-run on replay.                          │
// │   • Control flow before a suspend (branches, loops) must depend only on   │
// │     the input and on memoized step results — never on `Date.now()`,       │
// │     `Math.random()`, or un-stepped I/O.                                   │
// │   • Step names must be stable across runs and unique enough that the      │
// │     name+index key lines up on replay. The same body shape must produce   │
// │     the same sequence of step names.                                      │
// │                                                                           │
// │ This is exactly the contract of every replay engine — violating it makes  │
// │ resume diverge from the original run.                                     │
// ╰──────────────────────────────────────────────────────────────────────────╯

import type { StepTrace } from "./types.js";

/**
 * Serializable cache of a suspended run, sufficient to deterministically
 * replay the body up to (and past) the suspension point on resume.
 *
 * - `steps`     — recorded `ctx.step(...)` results keyed by `"name#index"`
 *                 (occurrence index per name). On replay these are returned
 *                 without re-invoking the step fn.
 * - `decisions` — resolved `ctx.suspend(...)` decisions keyed by token. Replay
 *                 feeds these into the matching gate so prior approvals are
 *                 honored across multiple sequential suspends.
 */
export interface ReplayCache {
  /** Memoized step results, keyed by `"name#index"`. */
  steps: Record<string, unknown>;
  /** Resolved suspend decisions, keyed by token. */
  decisions: Record<string, unknown>;
}

/** An empty replay cache. */
export function emptyReplayCache(): ReplayCache {
  return { steps: {}, decisions: {} };
}

/**
 * Control-flow signal thrown when a run hits a `ctx.suspend(token)` gate for
 * which no decision exists yet. This is intentionally **not** an `Error`
 * subclass so that `retry()`, `fallback()`, and `WorkflowRunError` wrapping
 * leave it alone — suspension is normal control flow, not a failure.
 *
 * `isWorkflowSuspended()` / the abort-style helpers detect it so combinators
 * propagate it untouched.
 */
export class WorkflowSuspended {
  /** Discriminant brand so structural checks are cheap and reliable. */
  readonly __workflowSuspended = true as const;
  /** Approval/HITL token identifying which gate suspended. */
  readonly token: string;
  /** Optional payload the gate surfaced for the approver (e.g. a draft). */
  readonly payload: unknown;
  /** Partial step trace recorded up to the suspension point. */
  readonly trace: StepTrace[];
  /** Replay cache to persist so the run can be resumed deterministically. */
  readonly cache: ReplayCache;

  constructor(token: string, payload: unknown, trace: StepTrace[], cache: ReplayCache) {
    this.token = token;
    this.payload = payload;
    this.trace = trace;
    this.cache = cache;
  }
}

/** True if `e` is the {@link WorkflowSuspended} control-flow signal. */
export function isWorkflowSuspended(e: unknown): e is WorkflowSuspended {
  return (
    e instanceof WorkflowSuspended ||
    (typeof e === "object" &&
      e !== null &&
      (e as { __workflowSuspended?: unknown }).__workflowSuspended === true)
  );
}
