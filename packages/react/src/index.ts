"use client";

// Pure parser — DOM-free, unit-testable.
export { parseEidenticStream, applyEvent } from "./parser.js";
export type {
  ParsedStreamState,
  TextMessage,
  ToolCall,
  ToolResult,
  ResultEvent,
  TurnUsage,
} from "./parser.js";

// React hooks.
export { useEidenticStream } from "./useEidenticStream.js";
export type {
  EidenticStreamState,
  EidenticStreamOptions,
  StreamStatus,
  SuspensionState,
} from "./useEidenticStream.js";

export { useAgent } from "./useAgent.js";

// Async run hooks (fire-and-poll pattern).
export { useAsyncRun, useRunStatus } from "./useAsyncRun.js";
export type {
  AsyncRunStatus,
  AsyncRunStatusResponse,
  AsyncRunOptions,
  UseAsyncRunReturn,
  UseRunStatusReturn,
} from "./useAsyncRun.js";

// Workflow hooks.
export { useWorkflowList, useWorkflowRun } from "./useWorkflow.js";
export type {
  StepTrace,
  WorkflowRunSummary,
  WorkflowRunDetail,
  WorkflowOptions,
  UseWorkflowListReturn,
  UseWorkflowRunReturn,
} from "./useWorkflow.js";
