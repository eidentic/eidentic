/**
 * Temporal point-in-time QA benchmark (`runTemporalBench`).
 *
 * Evaluates whether a Memory instance with a graph backend can answer point-in-time
 * questions: "what was X's <property> at <date>?" using the `validAt` parameter of
 * queryFacts. No LLM is required — answers are compared directly to gold.
 *
 * Two metrics:
 *   - pointInTimeAccuracy: fraction of non-current-state questions answered correctly.
 *   - currentStateAccuracy: fraction of "latest state" questions answered correctly.
 *
 * Cost transparency: llmCallsPerWrite and tokensUsedIfAny are always 0 for this
 * deterministic benchmark (no model calls). Reported for API consistency.
 *
 * This benchmark is ONLY passable by systems with timestamped fact validity. A system
 * that stores facts without validFrom/validUntil intervals cannot correctly answer
 * "what was X at <past date>?" — it will always return the current state.
 */

import type { Memory } from "@eidentic/memory";
import type { Scope } from "@eidentic/types";
import type { SyntheticTemporalDataset, TemporalQuestion } from "./datasets/temporal.js";

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** Per-question result in TemporalBenchReport. */
export interface TemporalQuestionResult {
  subject: string;
  predicate: string;
  askedAt: string;
  goldAnswer: string | null;
  systemAnswer: string | null;
  correct: boolean;
  /** "before-first-fact" | "at-boundary" | "mid-interval" | "current-state" */
  questionType: string;
  rationale: string;
}

/** Full report produced by runTemporalBench. */
export interface TemporalBenchReport {
  datasetName: string;

  /**
   * Accuracy on questions whose askedAt is BEFORE or BETWEEN known states
   * (excludes current-state questions). Range [0, 1]. Higher is better.
   */
  pointInTimeAccuracy: number;

  /**
   * Accuracy on questions asking for the latest / current state.
   * Range [0, 1]. Higher is better.
   */
  currentStateAccuracy: number;

  /**
   * Accuracy on questions asked BEFORE the first known fact (correct answer: null/no result).
   * Range [0, 1]. A system that returns stale facts here fails this metric.
   */
  beforeFirstFactAccuracy: number;

  /** Total questions evaluated. */
  totalQuestions: number;

  /**
   * LLM calls per write. Always 0 for this deterministic benchmark.
   * Present for cost-transparency API consistency.
   */
  llmCallsPerWrite: number;

  /**
   * Tokens used. Always 0 for this deterministic benchmark.
   * Present for cost-transparency API consistency.
   */
  tokensUsedIfAny: number;

  /** Per-question results for inspection. */
  results: TemporalQuestionResult[];
}

// ── Question classifier ────────────────────────────────────────────────────────────────────────

function classifyQuestion(q: TemporalQuestion): string {
  if (q.goldAnswer === null) return "before-first-fact";
  if (q.rationale.includes("exactly")) return "at-boundary";
  if (q.rationale.includes("latest") || q.rationale.includes("last transition")) {
    return "current-state";
  }
  return "mid-interval";
}

// ── Runner ─────────────────────────────────────────────────────────────────────────────────────

export interface TemporalBenchOptions {
  /**
   * Scope to use for assertFact and queryFacts calls.
   * Default: { kind: "agent", agentId: "bench:temporal" }
   */
  scope?: Scope;
}

/**
 * Run the temporal point-in-time QA benchmark.
 *
 * Workflow:
 *   1. Assert all facts from dataset.asserts into the memory graph, in ascending
 *      validFrom order (required for temporal-order correctness).
 *   2. For each question in dataset.questions, call queryFacts({ validAt: q.askedAt }).
 *   3. Compare the returned fact's object to q.goldAnswer.
 *   4. Aggregate into TemporalBenchReport.
 *
 * @param memory  A Memory instance with a configured graph backend (required).
 * @param dataset The synthetic temporal dataset produced by syntheticTemporalDataset().
 * @param opts    Optional scope configuration.
 */
export async function runTemporalBench(
  memory: Memory,
  dataset: SyntheticTemporalDataset,
  opts: TemporalBenchOptions = {},
): Promise<TemporalBenchReport> {
  if (!memory.graphEnabled) {
    throw new Error(
      "runTemporalBench: Memory must have a graph configured (pass `graph` to Memory constructor). " +
        "Temporal point-in-time queries require timestamped fact validity.",
    );
  }

  const scope: Scope = opts.scope ?? { kind: "agent", agentId: "bench:temporal" };

  // ── Step 1: Assert all facts in temporal order ────────────────────────────────────────────────
  // Sort asserts by validFrom ascending so temporal-order constraints are never violated.
  const sortedAsserts = [...dataset.asserts].sort((a, b) => {
    const va = a.validFrom ?? "";
    const vb = b.validFrom ?? "";
    return va < vb ? -1 : va > vb ? 1 : 0;
  });

  // Group by (subject, predicate) and assert in order to avoid temporal-order violations.
  // Since multiple entities share predicates, we process each (subject, predicate) pair
  // as an independent timeline.
  const grouped = new Map<string, typeof sortedAsserts>();
  for (const a of sortedAsserts) {
    const key = `${a.subject}::${a.predicate}`;
    const list = grouped.get(key) ?? [];
    list.push(a);
    grouped.set(key, list);
  }

  for (const [, assertList] of grouped) {
    // Already sorted within group because sortedAsserts is globally sorted
    for (const input of assertList) {
      try {
        await memory.assertFact(scope, input);
      } catch (err) {
        // Temporal-order violation: skip (should not happen with sorted input)
        // Surface as warning in test output if needed
        void err;
      }
    }
  }

  // ── Step 2 & 3: Answer each question via point-in-time queryFacts ─────────────────────────────
  const results: TemporalQuestionResult[] = [];

  for (const q of dataset.questions) {
    const facts = await memory.queryFacts({
      scope,
      subject: q.subject,
      predicate: q.predicate,
      validAt: q.askedAt,
    });

    // The system's answer: the object of the single currently-valid fact at askedAt, or null
    const systemAnswer =
      facts.length > 0 ? (facts[facts.length - 1]?.object ?? null) : null;

    const correct =
      q.goldAnswer === null
        ? systemAnswer === null // "before first fact" → expect no answer
        : systemAnswer === q.goldAnswer;

    const questionType = classifyQuestion(q);

    results.push({
      subject: q.subject,
      predicate: q.predicate,
      askedAt: q.askedAt,
      goldAnswer: q.goldAnswer,
      systemAnswer,
      correct,
      questionType,
      rationale: q.rationale,
    });
  }

  // ── Step 4: Aggregate metrics ──────────────────────────────────────────────────────────────────
  const currentStateResults = results.filter((r) => r.questionType === "current-state");
  const pointInTimeResults = results.filter((r) => r.questionType !== "current-state");
  const beforeFirstResults = results.filter((r) => r.questionType === "before-first-fact");

  function accuracy(rs: TemporalQuestionResult[]): number {
    if (rs.length === 0) return 1; // vacuously correct
    return rs.filter((r) => r.correct).length / rs.length;
  }

  return {
    datasetName: dataset.name,
    pointInTimeAccuracy: accuracy(pointInTimeResults),
    currentStateAccuracy: accuracy(currentStateResults),
    beforeFirstFactAccuracy: accuracy(beforeFirstResults),
    totalQuestions: results.length,
    llmCallsPerWrite: 0, // deterministic — no LLM calls
    tokensUsedIfAny: 0,
    results,
  };
}
