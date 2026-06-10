// ─── Public API ───────────────────────────────────────────────────────────────

// Types
export type {
  Step,
  StepContext,
  StepRetryPolicy,
  StepRunOptions,
  WorkflowEvent,
  StepTrace,
  WorkflowResult,
  Workflow,
} from "./types.js";

// Core step wrapper
export { step } from "./step.js";

// Combinators
export {
  chain,
  parallel,
  branch,
  retry,
  fallback,
  withTimeout,
  map,
  tap,
  MapError,
} from "./combinators.js";
export type {
  RetryOptions,
  MapOptions,
  MapCollectOptions,
  MapFailFastOptions,
  MapErrorPolicy,
  MapItemResult,
} from "./combinators.js";

// Agent adapter
export { agentStep } from "./agent-step.js";
export type { AgentStepOptions, AgentResultEvent } from "./agent-step.js";

// Workflow runner + fluent builder
export { workflow } from "./workflow.js";
export type { WorkflowBuilder, WorkflowStart, WorkflowOptions } from "./workflow.js";

// Workflow run error
export { WorkflowRunError } from "./workflow-internal.js";

// Suspend / human-in-the-loop (replay-based)
export { WorkflowSuspended, isWorkflowSuspended, emptyReplayCache } from "./suspend.js";
export type { ReplayCache } from "./suspend.js";

// Resume a suspended run
export { resumeWorkflow } from "./resume.js";
export type { ResumeOptions, ResumeResult } from "./resume.js";

// Run registry
export { createWorkflowRunRegistry, runStatusOf } from "./registry.js";
export type {
  WorkflowRunRecord,
  WorkflowRunRegistry,
  WorkflowRunRegistryOptions,
  WorkflowRunOwner,
  WorkflowRunStatus,
  WorkflowRunStore,
  WorkflowRunFilter,
  WorkflowSuspension,
  RecordOptions,
} from "./registry.js";

// Durable file store (port impl shipped in-package)
export { fileWorkflowRunStore } from "./file-store.js";
