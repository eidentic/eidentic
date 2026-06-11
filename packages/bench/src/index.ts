/**
 * @eidentic/bench — Memory benchmark harness (§6.10).
 *
 * Provides a runnable LongMemEval/LoCoMo/temporal-reasoning benchmark with deterministic recall
 * metric, a small bundled synthetic fixture for CI, and loaders for the real datasets (gated).
 *
 * Additionally provides write-quality and temporal point-in-time benchmarks:
 *   - runWriteQualityBench: contradiction suppression, junk resistance, duplicate resistance.
 *   - runTemporalBench: point-in-time QA with gold answers, requires timestamped fact validity.
 *   - syntheticTemporalDataset: deterministic generator for temporal state histories.
 */

// Core runner
export { runMemoryBench } from "./run.js";
export type { BenchOptions } from "./run.js";

// Deterministic recall metric
export { recallAtK, factRecall, normalizeText, normalizedIncludes } from "./recall.js";

// Bundled synthetic dataset (retrieval)
export { syntheticDataset } from "./datasets/synthetic.js";

// Legacy retrieval-style loaders (map to BenchDataset — old wrong schemas, preserved for backward compat)
export { loadLongMemEval as loadLongMemEvalLegacy } from "./loaders.js";
export { loadLoCoMo as loadLoCoMoLegacy } from "./loaders.js";

// LoCoMo real-schema loader + fair-run harness
export { loadLoCoMo, LOCOMO_SOURCE_SHA } from "./locomo-loader.js";
export { runLocomoBench } from "./locomo-run.js";
export { renderLocomoReportMarkdown } from "./locomo-render.js";
export type {
  LocomoReport,
  LocomoQuestionResult,
  LocomoBenchOptions,
  CategoryStats,
  TokenSummary,
  MemoryFactory,
} from "./locomo-run.js";
export type { PriceTable } from "./locomo-render.js";
export type {
  LocomoDataset,
  LocomoSample,
  LocomoSession,
  LocomoTurn,
  LocomoQA,
  LocomoCategory,
} from "./locomo-types.js";
export { resolveEvidence } from "./locomo-types.js";

// LongMemEval real-schema loader + fair-run harness
export { loadLongMemEval, parseLmeDateTimeString, LONGMEMEVAL_SOURCE } from "./lme-loader.js";
export { runLongMemEvalBench } from "./lme-run.js";
export { renderLongMemEvalReportMarkdown } from "./lme-render.js";
export type {
  LmeReport,
  LmeQuestionResult,
  LmeBenchOptions,
  LmeTypeStats,
  LmeTokenSummary,
  LmeMemoryFactory,
} from "./lme-run.js";
export type { LmePriceTable } from "./lme-render.js";
export type {
  LmeDataset,
  LmeQuestion,
  LmeSession,
  LmeTurn,
  LmeBaseType,
  LmeQuestionType,
} from "./lme-types.js";

// Write-quality benchmark
export { runWriteQualityBench, CONTRADICTION_FIXTURES, JUNK_STREAM_FIXTURES } from "./write-quality.js";
export type {
  WriteQualityReport,
  WriteQualityDetail,
  WriteQualityOptions,
  ContradictionFixture,
  JunkItem,
} from "./write-quality.js";

// Temporal point-in-time benchmark
export { runTemporalBench } from "./temporal.js";
export type {
  TemporalBenchReport,
  TemporalBenchOptions,
  TemporalQuestionResult,
} from "./temporal.js";

// Temporal dataset generator
export { syntheticTemporalDataset } from "./datasets/temporal.js";
export type {
  SyntheticTemporalDataset,
  TemporalEntity,
  TemporalQuestion,
  StateTransition,
} from "./datasets/temporal.js";

// All retrieval benchmark types
export type {
  BenchTurn,
  BenchQuestion,
  BenchCase,
  BenchDataset,
  BenchReport,
  QuestionResult,
  CaseResult,
} from "./types.js";
