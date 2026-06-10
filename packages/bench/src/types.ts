/**
 * Core dataset shapes for the Eidentic memory benchmark harness (§6.10).
 *
 * A BenchDataset is a named collection of BenchCase objects. Each case represents a
 * multi-session conversation (turns) followed by a set of retrieval questions. Each question
 * specifies one or more gold facts — substrings that MUST appear in the retrieved context for
 * the answer to be considered recalled.
 */

/** A single conversation turn ingested into Memory before recall is evaluated. */
export interface BenchTurn {
  role: "user" | "assistant";
  text: string;
  /** Optional session identifier — used to group turns into multi-session conversations. */
  sessionId?: string;
  /** Optional ISO timestamp — used for temporal ordering and knowledge-update cases. */
  ts?: string;
}

/** A single retrieval question with gold evidence. */
export interface BenchQuestion {
  question: string;
  /**
   * Substrings that must appear (normalized) in the top-K retrieved context for this question to
   * be considered correctly recalled. Recall@K = fraction of goldFacts that are present.
   */
  goldFacts: string[];
  /** Optional ground-truth answer string (used by the optional LLM judge for answer-correctness). */
  answer?: string;
  /** Category for per-category breakdown in BenchReport. */
  category?: "single-session" | "multi-session" | "temporal" | "knowledge-update";
}

/** A single benchmark case: ingested turns + evaluation questions. */
export interface BenchCase {
  id: string;
  turns: BenchTurn[];
  questions: BenchQuestion[];
}

/** A named benchmark dataset containing one or more cases. */
export interface BenchDataset {
  name: string;
  cases: BenchCase[];
}

/** Per-question result recorded in BenchReport. */
export interface QuestionResult {
  caseId: string;
  question: string;
  category?: BenchQuestion["category"];
  recallAtK: number;
  /** Snippets retrieved (text only, for inspection). */
  retrieved: string[];
  /** Gold facts found vs expected. */
  foundFacts: number;
  totalFacts: number;
}

/** Per-case summary in BenchReport. */
export interface CaseResult {
  caseId: string;
  recallAtK: { mean: number; n: number };
  questions: QuestionResult[];
}

/** The complete report produced by runMemoryBench. */
export interface BenchReport {
  dataset: string;
  recallAtK: { mean: number; n: number };
  byCategory: Record<string, { mean: number; n: number }>;
  perCase: CaseResult[];
}
