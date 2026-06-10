import type { Step, Workflow } from "./types.js";
import { makeWorkflow, type WorkflowMeta } from "./workflow-internal.js";
import { type WorkflowBuilder, type WorkflowStart, createWorkflowStart } from "./builder.js";

/** Definition-level options accepted by `workflow(...)`. */
export interface WorkflowOptions {
  /** Optional version tag recorded on every run (registry list/filters). */
  version?: string;
}

// ─── workflow() overloads ─────────────────────────────────────────────────────

/**
 * Fluent builder overload — `workflow(name, opts?)` (no body).
 * Returns a `WorkflowStart` to chain `.step(...)` calls on. Pass `opts.version`
 * to tag every run with a version.
 *
 * @example
 * const wf = workflow("triage", { version: "2.1.0" })
 *   .step(classify)
 *   .branch(c => c === "billing", billing, tech);
 */
export function workflow(name: string, opts?: WorkflowOptions): WorkflowStart;

/**
 * Functional / imperative overload — `workflow(name, body, opts?)`.
 * `body` is a plain `Step<I,O>` (the functional form) or an async function
 * that destructures `ctx` to use `ctx.step` / `ctx.all` / `ctx.suspend`.
 *
 * @example
 * // Functional:
 * const wf = workflow("triage", chain(step("a", a), step("b", b)));
 *
 * // Imperative with HITL:
 * const wf = workflow("triage", async (ticket, { step, suspend }) => {
 *   const draft = await step("draft", drafter, ticket);
 *   const approved = await suspend<boolean>("approve-draft", draft);
 *   return approved ? step("send", sender, draft) : "rejected";
 * }, { version: "1.0.0" });
 */
export function workflow<I, O>(name: string, body: Step<I, O>, opts?: WorkflowOptions): Workflow<I, O>;

export function workflow<I, O>(
  name: string,
  bodyOrOpts?: Step<I, O> | WorkflowOptions,
  maybeOpts?: WorkflowOptions,
): Workflow<I, O> | WorkflowStart {
  // Builder overload: second arg is absent or a plain options object.
  if (bodyOrOpts === undefined || typeof bodyOrOpts !== "function") {
    const opts = bodyOrOpts as WorkflowOptions | undefined;
    return createWorkflowStart(name, toMeta(opts));
  }
  return makeWorkflow(name, bodyOrOpts, toMeta(maybeOpts));
}

function toMeta(opts?: WorkflowOptions): WorkflowMeta | undefined {
  if (opts?.version === undefined) return undefined;
  return { version: opts.version };
}

// Re-export builder types for consumers
export type { WorkflowBuilder, WorkflowStart };
