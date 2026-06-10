export const EVAL_PACKAGE = "@eidentic/eval";

// Trajectory
export { trajectoryFromEvents, toolCallsOf, toolNamesOf } from "./trajectory.js";
export type { Trajectory, TrajectoryStep, ModelCallStep, ToolCallStep, ToolResultStep } from "./trajectory.js";

// Scorer contract
export { clamp01, passAt } from "./scorer.js";
export type { Scorer, ScoreContext, ScoreResult, DatasetExpectation } from "./scorer.js";

// Deterministic scorers
export { trajectory } from "./deterministic.js";

// Conformance cases
export { scorerConformanceCases } from "./conformance.js";
export type { ScorerCase } from "./conformance.js";

// LLM-as-judge scorers
export { llmJudge } from "./judge.js";
export type { JudgeOptions } from "./judge.js";

// Dataset types, captureFailure, and JSONL load/save
export { captureFailure, saveDatasetJsonl, loadDatasetJsonl } from "./dataset.js";
export type { DatasetCase, EvalDataset, CapturedSession, CaptureFailureOptions } from "./dataset.js";

// Runner
export { createRunner } from "./runner.js";
export type { Runner, RunnerResult } from "./runner.js";

// Evaluate
export { evaluate } from "./evaluate.js";
export type { EvalReport, CaseReport, SampleScores, AggregateEntry, EvaluateOptions } from "./evaluate.js";

// CI gate
export { assertPassRate, summarize, EvalThresholdError } from "./gate.js";
export type { AssertPassRateOptions, FailedCase } from "./gate.js";

// Trace promotion (production run → eval case)
export { promoteTraceToEvalCase, collectPromotedCases } from "./promote.js";
export type { PromoteTraceOptions } from "./promote.js";

// Compare reports (baseline vs current for CI regression detection)
export { compareReports } from "./compare.js";
export type { CompareResult, CompareOptions, RegressionEntry, ImprovementEntry } from "./compare.js";

// Markdown report renderer (GitHub-comment-friendly)
export { renderReportMarkdown } from "./markdown.js";
export type { RenderReportMarkdownOptions } from "./markdown.js";
