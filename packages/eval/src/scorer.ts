import type { ToolSchema } from "@eidentic/types";
import type { Trajectory } from "./trajectory.js";

/** The result of one scorer over one (case, sample). `score` in [0,1]. */
export interface ScoreResult {
  score: number;
  passed: boolean;
  rationale?: string;
  details?: Record<string, unknown>;
}

/** Everything a scorer may read. Deterministic scorers ignore the model/judge entirely. */
export interface ScoreContext {
  /** The case input (the user prompt). */
  input: string;
  /** The normalized trajectory derived from the run's event log. */
  trajectory: Trajectory;
  /** Final answer text, when the runner produced one (judges use this). */
  finalText?: string;
  /** Terminal subtype ("success" | "error" | "max_turns" | ...), when available. */
  finalSubtype?: string;
  /** 0-based index of this sample within the case (trajectory metrics need repeats). */
  sampleIndex: number;
  /** The case's expected/ground-truth payload (from the DatasetCase), passed through for scorers. */
  expected?: DatasetExpectation;
  /** Optional tool schemas (from a registry) — enables schema validity + idempotency-marker checks. */
  toolSchemas?: ToolSchema[];
}

/** Per-case expectations a scorer may consult (carried on the DatasetCase). */
export interface DatasetExpectation {
  /** Tools that MUST appear among the calls (toolCorrectness). */
  expectedTools?: string[];
  /** Exact ordered tool sequence (toolSequence). */
  expectedSequence?: string[];
  /** Per-tool required input params (requiredParams): { toolName: ["paramA", ...] }. */
  requiredParams?: Record<string, string[]>;
  /** Budget for stepEfficiency: max tool calls (and/or model calls). */
  maxToolCalls?: number;
  maxModelCalls?: number;
  /** verifierStall threshold: max allowed consecutive same-name tool spans (default 10, §11.3). */
  maxSameNameRun?: number;
}

/** A scorer: a named function over a ScoreContext. Deterministic ones are sync + pure. */
export interface Scorer {
  name: string;
  score(ctx: ScoreContext): Promise<ScoreResult> | ScoreResult;
}

/** Clamp any number into [0,1]; NaN/non-finite => 0 (fail-closed). */
export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** A pass when score >= threshold (default 1 — deterministic checks are pass/fail). */
export const passAt = (score: number, threshold = 1): boolean => score >= threshold;
