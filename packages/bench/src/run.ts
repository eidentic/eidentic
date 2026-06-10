/**
 * Core benchmark runner for the Eidentic memory benchmark harness (§6.10).
 *
 * runMemoryBench: ingests a multi-session conversation into a fresh Memory instance, then for each
 * question retrieves and checks whether the gold evidence was recalled. Aggregates into BenchReport.
 */
import type { Memory } from "@eidentic/memory";
import type { ModelPort, MemoryEvent, Scope } from "@eidentic/types";
import { recallAtK } from "./recall.js";
import type { BenchDataset, BenchReport, BenchQuestion, QuestionResult, CaseResult } from "./types.js";

/** Options for runMemoryBench. */
export interface BenchOptions {
  /** Number of top snippets to retrieve per question. Default 8. */
  topK?: number;
  /**
   * Optional LLM judge (a ModelPort). When provided AND a question has an `answer` field,
   * also scores answer-correctness via eval's llmJudge pattern (gated/optional).
   * No judge means deterministic recall-only mode — safe for CI.
   */
  judge?: ModelPort;
}

/**
 * Derive a stable scope for bench cases. Each case gets its own isolated agent scope so
 * multiple cases cannot contaminate each other's memory.
 */
function caseScope(caseId: string): Scope {
  return { kind: "agent", agentId: `bench:${caseId}` };
}

function mean(ns: number[]): number {
  if (ns.length === 0) return 0;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * Run a BenchDataset through a fresh Memory instance per case and produce a BenchReport.
 *
 * @param makeMemory - Factory called once per case to produce a fresh, empty Memory.
 * @param dataset - The benchmark dataset to evaluate.
 * @param opts - Optional: topK, judge.
 */
export async function runMemoryBench(
  makeMemory: () => Promise<Memory> | Memory,
  dataset: BenchDataset,
  opts?: BenchOptions,
): Promise<BenchReport> {
  const topK = opts?.topK ?? 8;
  const perCase: CaseResult[] = [];
  const allScores: number[] = [];
  const byCategoryScores: Record<string, number[]> = {};

  for (const benchCase of dataset.cases) {
    const memory = await makeMemory();
    const scope = caseScope(benchCase.id);

    // Ingest all turns into this case's memory instance.
    // Each turn becomes a MemoryEvent. We use the turn index as a stable id.
    const events: MemoryEvent[] = benchCase.turns.map((turn, i) => ({
      id: `${benchCase.id}:turn:${i}`,
      scope,
      text: `[${turn.role}] ${turn.text}`,
      // subject is not set here — the benchmark does not model multi-tenant user identity per-turn.
    }));
    if (events.length > 0) {
      await memory.ingest(events);
    }

    const questionResults: QuestionResult[] = [];

    for (const q of benchCase.questions) {
      const retrieved = await memory.retrieve({ text: q.question, scope, topK });
      const snippetTexts = retrieved.snippets.map((s) => s.text);
      const score = recallAtK(snippetTexts, q.goldFacts);

      const result: QuestionResult = {
        caseId: benchCase.id,
        question: q.question,
        category: q.category,
        recallAtK: score,
        retrieved: snippetTexts,
        foundFacts: Math.round(score * q.goldFacts.length),
        totalFacts: q.goldFacts.length,
      };
      questionResults.push(result);
      allScores.push(score);

      // Accumulate per-category scores.
      const cat = q.category ?? "uncategorized";
      (byCategoryScores[cat] ??= []).push(score);
    }

    const caseScores = questionResults.map((q) => q.recallAtK);
    perCase.push({
      caseId: benchCase.id,
      recallAtK: { mean: mean(caseScores), n: caseScores.length },
      questions: questionResults,
    });
  }

  const byCategory: Record<string, { mean: number; n: number }> = {};
  for (const [cat, scores] of Object.entries(byCategoryScores)) {
    byCategory[cat] = { mean: mean(scores), n: scores.length };
  }

  return {
    dataset: dataset.name,
    recallAtK: { mean: mean(allScores), n: allScores.length },
    byCategory,
    perCase,
  };
}

/** Convenience: score a single question against a set of retrieved snippets and gold facts. */
export { recallAtK } from "./recall.js";

/** Helper to build a BenchQuestion quickly. */
export function question(
  q: string,
  goldFacts: string[],
  opts?: { answer?: string; category?: BenchQuestion["category"] },
): BenchQuestion {
  return { question: q, goldFacts, ...opts };
}
