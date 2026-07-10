import type { Workflow, WorkflowEvent, WorkflowResult } from "./types.js";
import type { WorkflowRunRecord, WorkflowRunRegistry } from "./registry.js";
import { executeBody, getWorkflowBody, type WorkflowMeta } from "./workflow-internal.js";

// ─── resumeWorkflow() ─────────────────────────────────────────────────────────

/** Options for {@link resumeWorkflow}. */
export interface ResumeOptions {
  /** Registry holding the suspended record (and where the result is written back). */
  registry: WorkflowRunRegistry;
  /** The human-in-the-loop decision to resolve the pending `ctx.suspend()` gate with. */
  decision: unknown;
  /** Optional cancellation signal for the replayed run. */
  signal?: AbortSignal;
  /** Optional event sink for the replayed run. */
  onEvent?: (e: WorkflowEvent) => void;
}

/** Outcome of a resume attempt. */
export type ResumeResult<O> =
  | { kind: "completed"; record: WorkflowRunRecord; output: O; trace: WorkflowResult<O>["trace"] }
  | { kind: "suspended"; record: WorkflowRunRecord; token: string; payload: unknown }
  | { kind: "error"; record: WorkflowRunRecord; error: unknown };

/**
 * Resume a suspended workflow run by replaying its body deterministically.
 *
 * Loads the suspended record `runId` from `registry`, records `decision` against
 * the pending suspend token, then re-executes `workflow`'s body from the start —
 * replaying memoized `ctx.step(...)` results (their fns are NOT re-invoked) and
 * resolving prior `ctx.suspend(...)` gates from the stored decisions. The same
 * registry record is updated in place to its new lifecycle state:
 *
 *  - resolves all gates and finishes → `runStatus: "completed"`
 *  - hits a further `ctx.suspend(...)` → `runStatus: "suspended"` (resumable again)
 *  - throws                          → `runStatus: "error"`
 *
 * Multiple sequential suspends are supported: each resume replays all past
 * decisions, so approvals accumulate across calls.
 *
 * DETERMINISM: the body re-runs top-to-bottom on every resume. Keep side effects
 * inside `ctx.step(...)` so they are memoized, not repeated. See the suspend docs.
 *
 * @throws if the run is unknown or is not in a suspended state.
 */
export async function resumeWorkflow<I, O>(
  workflow: Workflow<I, O>,
  runId: string,
  opts: ResumeOptions,
): Promise<ResumeResult<O>> {
  const { registry, decision } = opts;
  const initial = registry.get(runId);
  if (initial === undefined) {
    throw new Error(`resumeWorkflow: unknown run id "${runId}"`);
  }
  if (initial.suspension === undefined) {
    throw new Error(`resumeWorkflow: run "${runId}" is not suspended (status: ${initial.runStatus ?? initial.status})`);
  }

  const body = getWorkflowBody<I, O>(workflow);
  if (body === undefined) {
    throw new Error(
      "resumeWorkflow: workflow has no replayable body. Pass the same workflow object used to start the run.",
    );
  }

  const { record: prev, claimId } = await registry.claimResume(runId, initial.suspension.token);
  const { token, cache, input } = prev.suspension!;
  // Seed the pending gate's decision so replay resolves it instead of suspending.
  const seededCache = {
    steps: { ...cache.steps },
    decisions: { ...cache.decisions, [token]: decision },
  };

  const exec = await executeBody<I, O>(workflow.name, body, input as I, {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
    cache: seededCache,
  }).catch((err: unknown) => ({ kind: "threw" as const, err }));

  const version = prev.version;
  const meta: WorkflowMeta | undefined = version !== undefined ? { version } : undefined;

  if ("kind" in exec && exec.kind === "threw") {
    // Body threw (WorkflowRunError or other) — transition to error.
    const errMsg = exec.err instanceof Error ? exec.err.message : String(exec.err);
    const errRec: WorkflowRunRecord = {
      ...prev,
      status: "error",
      runStatus: "error",
      error: errMsg,
      suspension: undefined,
    };
    delete errRec.suspension;
    const record = await registry.finishResume(runId, claimId, errRec);
    return { kind: "error", record, error: exec.err };
  }

  if (exec.kind === "suspended") {
    // Re-suspended on a later gate — update with the new suspension state.
    const nextRec: WorkflowRunRecord = {
      ...prev,
      status: "ok",
      runStatus: "suspended",
      trace: exec.trace.map((s) => ({ ...s })),
      stepCount: exec.trace.length,
      suspension: {
        token: exec.signal.token,
        ...(exec.signal.payload !== undefined ? { payload: exec.signal.payload } : {}),
        cache: exec.signal.cache,
        input,
      },
      ...(meta?.version !== undefined ? { version: meta.version } : {}),
    };
    const record = await registry.finishResume(runId, claimId, nextRec);
    return { kind: "suspended", record, token: exec.signal.token, payload: exec.signal.payload };
  }

  // Completed — write the final output + trace, clear suspension.
  const trace = exec.trace.map((s) => ({ ...s }));
  const status: "ok" | "error" = trace.some((s) => s.status === "error") ? "error" : "ok";
  const startedAt = trace.length > 0 ? trace.reduce((m, s) => Math.min(m, s.startedAt), Infinity) : prev.startedAt;
  const endAt = trace.length > 0 ? trace.reduce((m, s) => Math.max(m, s.startedAt + s.durationMs), 0) : 0;
  const completedRec: WorkflowRunRecord = {
    ...prev,
    status,
    runStatus: status === "error" ? "error" : "completed",
    trace,
    stepCount: trace.length,
    startedAt: trace.length > 0 ? startedAt : prev.startedAt,
    durationMs: trace.length > 0 ? Math.max(0, endAt - startedAt) : prev.durationMs,
    ...(exec.output !== undefined ? { output: exec.output } : {}),
    suspension: undefined,
  };
  delete completedRec.suspension;
  const record = await registry.finishResume(runId, claimId, completedRec);
  return { kind: "completed", record, output: exec.output, trace };
}
