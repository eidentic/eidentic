/**
 * Fair-run LongMemEval benchmark harness.
 *
 * Key fair-run rules (non-negotiable, documented for methodology transparency):
 *
 * 1. PER-QUESTION memory scope — each question gets its own fresh haystack ingested into
 *    a fresh Memory instance. (Unlike LoCoMo which is per-conversation, LongMemEval
 *    is per-question: each question has its own haystack of ~50 sessions.)
 *
 * 2. Dual-granularity ingest — per-turn entries carry the session date in text so
 *    retrieved snippets are temporally anchored; one per-session chunk entry preserves
 *    multi-turn context for questions whose evidence spans adjacent turns.
 *
 * 3. Current date context — the question_date is passed to the answer prompt so temporal
 *    questions can reason about recency (e.g. "last week").
 *
 * 4. Memory-mode answer step — retrieve topK <= 10 snippets (never inflate topK to
 *    bypass retrieval quality), build a prompt from retrieved snippets + question + current date.
 *
 * 5. Full-context mode — the MANDATORY baseline. Sessions are concatenated in date order
 *    with session headers; if a haystack exceeds the context cap (120k chars ≈ ~90k tokens
 *    for gpt-4o-mini's 128k context), oldest sessions are truncated first and recorded.
 *
 * 6. Judging — strict LLM judge: correct only when model answer contains the gold answer's
 *    specific info (paraphrase ok; temporal: equivalent date expressions ok).
 *    For abstention questions: correct = model declined / said no-info / identified the
 *    flawed premise; fabricating a concrete answer = wrong.
 *
 * 7. Metrics — overall accuracy + per-question-type accuracy + abstention accuracy reported
 *    separately + token/cost accounting per phase + wall-clock. Full config disclosure in report.
 *
 * 8. Determinism — seed recorded; seeded shuffle used when questionLimit is set.
 *
 * 9. Resilience — per-question try/catch; checkpoint-resume via JSONL file.
 */

import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ModelPort, ModelResponse, MemoryEvent, Scope } from "@eidentic/types";
import type { Memory } from "@eidentic/memory";
import type { LmeDataset, LmeQuestion, LmeSession } from "./lme-types.js";
import { LONGMEMEVAL_SOURCE } from "./lme-loader.js";

// ── Seeded PRNG (xorshift32 — same as datasets/temporal.ts and locomo-run.ts) ──

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── Types ──────────────────────────────────────────────────────────────────────

/** Per-question scored row (also used as checkpoint entry). */
export interface LmeQuestionResult {
  questionId: string;
  questionType: string;
  isAbstention: boolean;
  question: string;
  goldAnswer: string;
  modelAnswer: string;
  correct: boolean;
  /** True if the model appeared to abstain (no-info / declined). */
  appearedToAbstain: boolean;
  /** True if context was truncated in full-context mode. */
  contextTruncated?: boolean;
  error?: string;
  /** Tokens used in the answer step. */
  answerInputTokens: number;
  answerOutputTokens: number;
  /** Tokens used in the judge step. */
  judgeInputTokens: number;
  judgeOutputTokens: number;
}

/** Token / cost summary. */
export interface LmeTokenSummary {
  ingestEmbedTokens: number;
  answerInputTokens: number;
  answerOutputTokens: number;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Accuracy stats for a question type or overall. */
export interface LmeTypeStats {
  correct: number;
  total: number;
  accuracy: number;
}

/** Full benchmark report. */
export interface LmeReport {
  /** Run configuration (included in every published result for transparency). */
  config: {
    mode: "memory" | "full-context";
    topK: number;
    answerModelId: string;
    judgeModelId: string;
    datasetSource: typeof LONGMEMEVAL_SOURCE;
    seed: number;
    types: string[];
    questionsRun: number;
  };
  /** Overall accuracy on all non-abstention questions. */
  overall: LmeTypeStats;
  /** Per-question-type accuracy (keys = type strings without "_abs" suffix). */
  byType: Record<string, LmeTypeStats>;
  /** Abstention accuracy: correct = model declined; wrong = fabricated concrete answer. */
  abstentionAccuracy?: LmeTypeStats;
  /** Token usage accounting. */
  tokens: LmeTokenSummary;
  /** Wall-clock duration in milliseconds. */
  wallClockMs: number;
  /** Individual question results. */
  questions: LmeQuestionResult[];
  /** Count of questions that threw errors (counted as wrong, not skipped). */
  errorCount: number;
}

/** Factory for a fresh Memory instance, called once per question. */
export type LmeMemoryFactory = (questionId: string) => Memory | Promise<Memory>;

/** Options for runLongMemEvalBench. */
export interface LmeBenchOptions {
  /** Path to longmemeval_s.json (required unless dataset is provided). */
  dataPath?: string;
  /** Pre-loaded dataset (avoids re-reading the file if already loaded). */
  dataset?: LmeDataset;
  /** Factory for a fresh Memory per question (required when mode="memory"). */
  memoryFactory?: LmeMemoryFactory;
  /** Model used to generate answers. */
  answerModel: ModelPort;
  /** Model used to judge correctness. */
  judgeModel: ModelPort;
  /** "memory" requires memoryFactory; "full-context" feeds the full haystack as context. */
  mode: "memory" | "full-context";
  /** Question types to include (default: all). */
  types?: string[];
  /** Cap on questions to process (for quick pilot runs). */
  questionLimit?: number;
  /** Random seed for shuffle reproducibility. Default 42. */
  seed?: number;
  /** Max snippets retrieved per question in memory mode. MUST be <= 10. Default 10. */
  topK?: number;
  /** Concurrency (questions in flight simultaneously). Default 1. */
  concurrency?: number;
  /** Progress callback: (questionsCompleted, questionsTotal) */
  onProgress?: (done: number, total: number) => void;
  /** Path to a JSONL checkpoint file. Existing rows are skipped on resume. */
  checkpointPath?: string;
  /**
   * Max characters for full-context haystack (to avoid exceeding model context).
   * Default 480000 chars (~120k tokens at ~4 chars/token, fitting gpt-4o-mini 128k).
   * When exceeded, oldest sessions are dropped first and contextTruncated is recorded.
   */
  fullContextMaxChars?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default full-context size cap in characters. */
const DEFAULT_FULL_CONTEXT_MAX_CHARS = 480_000;

/** Decline patterns for abstention detection. */
const DECLINE_PATTERNS =
  /\bno information available\b|\bi (don'?t|do not) (know|have)\b|\bcannot (find|answer|determine|provide)\b|\bnot (mentioned|stated|provided|found|available)\b|\bunable to (find|answer|determine)\b|\bno relevant (information|data)\b/i;

function appearsToDecline(answer: string): boolean {
  return DECLINE_PATTERNS.test(answer);
}

// ── Prompt builders ────────────────────────────────────────────────────────────

const ANSWER_INSTRUCTION =
  "Answer the question concisely and specifically based only on the information provided. " +
  "If the provided context does not contain the answer, reply exactly: No information available";

function buildMemoryAnswerPrompt(
  snippets: string[],
  question: string,
  currentDate: string,
): string {
  const context =
    snippets.length > 0
      ? snippets.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")
      : "(no relevant context retrieved)";
  const dateNote = currentDate ? `\nCurrent date: ${currentDate}` : "";
  return `Context from conversation history:\n${context}${dateNote}\n\nQuestion: ${question}\n\n${ANSWER_INSTRUCTION}`;
}

function buildFullContextAnswerPrompt(
  haystackText: string,
  question: string,
  currentDate: string,
): string {
  const dateNote = currentDate ? `\nCurrent date: ${currentDate}` : "";
  return `Conversation history:\n${haystackText}${dateNote}\n\nQuestion: ${question}\n\n${ANSWER_INSTRUCTION}`;
}

function buildJudgePrompt(
  question: string,
  goldAnswer: string,
  modelAnswer: string,
  questionType: string,
  isAbstention: boolean,
): string {
  if (isAbstention) {
    return (
      `You are a strict judge. This question requires the model to recognize that the ` +
      `information is not present in the conversation history, or that the premise is flawed. ` +
      `A CORRECT response means the model abstained, said something equivalent to ` +
      `"No information available", "I don't know", or identified that the premise is wrong. ` +
      `An INCORRECT response means the model fabricated a specific, concrete answer.\n\n` +
      `Question: ${question}\n` +
      `Model answer: ${modelAnswer}\n\n` +
      `Respond with JSON only: {"correct": true} if the model appropriately abstained, ` +
      `{"correct": false} if it fabricated a specific answer.`
    );
  }
  const temporalNote =
    questionType === "temporal-reasoning"
      ? "\nFor time/date questions: equivalent date expressions referring to the same date or duration are correct."
      : "";
  return (
    `You are a strict judge evaluating whether a model answer is correct.\n` +
    `CORRECT: the model answer contains the specific information in the gold answer ` +
    `(exact match or clear paraphrase is fine).${temporalNote}\n` +
    `WRONG: the model answer is vague, only topically related, contradicts the gold answer, ` +
    `or says "no information" when a specific answer exists.\n\n` +
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer}\n` +
    `Model answer: ${modelAnswer}\n\n` +
    `Respond with JSON only: {"correct": true} or {"correct": false}`
  );
}

// ── Haystack rendering ─────────────────────────────────────────────────────────

function renderHaystack(sessions: LmeSession[]): string {
  const lines: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const sess = sessions[i]!;
    const label = `Session ${i + 1} — ${sess.dateTime || sess.id}`;
    lines.push(label);
    for (const turn of sess.turns) {
      const roleLabel = turn.role === "user" ? "User" : "Assistant";
      lines.push(`[${roleLabel}]: ${turn.content}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function renderHaystackCapped(
  sessions: LmeSession[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const full = renderHaystack(sessions);
  if (full.length <= maxChars) return { text: full, truncated: false };

  // Truncate oldest sessions first (binary search-style: drop from the front)
  let kept = sessions.slice();
  while (kept.length > 1) {
    kept = kept.slice(1);
    const t = renderHaystack(kept);
    if (t.length <= maxChars) return { text: t, truncated: true };
  }
  // Last resort: hard-truncate the single remaining session
  return { text: renderHaystack(kept).slice(0, maxChars), truncated: true };
}

// ── Ingest helpers ─────────────────────────────────────────────────────────────

async function ingestQuestionIntoMemory(
  question: LmeQuestion,
  memory: Memory,
  scope: Scope,
): Promise<void> {
  const events: MemoryEvent[] = [];

  for (let i = 0; i < question.sessions.length; i++) {
    const sess = question.sessions[i]!;
    const sessLabel = `Session ${i + 1} — ${sess.dateTime || sess.id}`;

    // Turn-level entries: session date travels WITH each turn so retrieved
    // snippets are temporally anchored ("last week" is resolvable).
    for (let t = 0; t < sess.turns.length; t++) {
      const turn = sess.turns[t]!;
      const roleLabel = turn.role === "user" ? "User" : "Assistant";
      events.push({
        id: `${question.id}:sess${i}:turn${t}`,
        scope,
        text: `[${sessLabel}] [${roleLabel}]: ${turn.content}`,
        metadata: {
          sessionId: sess.id,
          sessionIndex: i,
          turnRole: turn.role,
          ingestedAt: sess.dateTimeMs || undefined,
        },
      });
    }

    // Session-level chunk: one coherent entry per session so questions whose
    // evidence spans several adjacent turns retrieve complete context.
    const sessionText = [
      sessLabel,
      ...sess.turns.map((t) => `[${t.role === "user" ? "User" : "Assistant"}]: ${t.content}`),
    ].join("\n");
    events.push({
      id: `${question.id}:sess${i}:chunk`,
      scope,
      text: sessionText,
      metadata: {
        sessionId: sess.id,
        sessionIndex: i,
        ingestedAt: sess.dateTimeMs || undefined,
      },
    });
  }

  await memory.ingest(events);
}

// ── Judge call ─────────────────────────────────────────────────────────────────

interface JudgeResult {
  correct: boolean;
  inputTokens: number;
  outputTokens: number;
}

async function callJudge(
  judgeModel: ModelPort,
  prompt: string,
): Promise<JudgeResult> {
  const response: ModelResponse = await judgeModel.complete({
    messages: [{ role: "user", content: prompt }],
    tools: [],
    outputSchema: {
      type: "object",
      properties: { correct: { type: "boolean" } },
      required: ["correct"],
      // OpenAI strict structured-output mode requires this to be explicit.
      additionalProperties: false,
    },
  });

  let correct = false;
  if (
    response.object &&
    typeof (response.object as { correct?: unknown }).correct === "boolean"
  ) {
    correct = (response.object as { correct: boolean }).correct;
  } else {
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .toLowerCase()
      .trim();
    if (/"correct"\s*:\s*true/i.test(text)) correct = true;
    else if (/"correct"\s*:\s*false/i.test(text)) correct = false;
    else correct = text.includes("true");
  }

  return {
    correct,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  };
}

// ── Checkpoint helpers ─────────────────────────────────────────────────────────

async function loadCheckpoint(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const raw = await readFile(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<LmeQuestionResult>;
      if (row.questionId) done.add(row.questionId);
    } catch {
      // ignore malformed lines
    }
  }
  return done;
}

async function appendCheckpointRow(
  path: string,
  row: LmeQuestionResult,
): Promise<void> {
  await appendFile(path, JSON.stringify(row) + "\n", "utf-8");
}

// ── Main runner ────────────────────────────────────────────────────────────────

/**
 * Run the LongMemEval benchmark with the given options.
 *
 * @param opts - Configuration (see LmeBenchOptions).
 * @returns    - Full LmeReport with metrics, token accounting, and per-question details.
 */
export async function runLongMemEvalBench(
  opts: LmeBenchOptions,
): Promise<LmeReport> {
  const {
    answerModel,
    judgeModel,
    mode,
    types,
    questionLimit,
    seed = 42,
    concurrency = 1,
    onProgress,
    checkpointPath,
    fullContextMaxChars = DEFAULT_FULL_CONTEXT_MAX_CHARS,
  } = opts;

  // topK is capped at 10 to preserve retrieval quality
  const topK = Math.min(opts.topK ?? 10, 10);
  const rng = makeRng(seed);

  // Validate memory factory before doing any work
  if (mode === "memory" && !opts.memoryFactory) {
    throw new Error("runLongMemEvalBench: memoryFactory is required when mode='memory'");
  }

  // Load dataset
  let dataset: LmeDataset;
  if (opts.dataset) {
    dataset = opts.dataset;
  } else if (opts.dataPath) {
    const { loadLongMemEval: loader } = await import("./lme-loader.js");
    dataset = await loader(opts.dataPath);
  } else {
    throw new Error("runLongMemEvalBench: either dataPath or dataset must be provided");
  }

  // Filter by type
  let questions = dataset.questions;
  if (types && types.length > 0) {
    questions = questions.filter((q) => types.includes(q.type) || types.includes(q.baseType));
  }

  // Apply questionLimit with seeded shuffle
  if (questionLimit !== undefined && questionLimit < questions.length) {
    questions = seededShuffle(questions, makeRng(seed)).slice(0, questionLimit);
  }

  // Load checkpoint
  const checkpoint = checkpointPath
    ? await loadCheckpoint(checkpointPath)
    : new Set<string>();

  const results: LmeQuestionResult[] = [];
  let totalAnswerInputTokens = 0;
  let totalAnswerOutputTokens = 0;
  let totalJudgeInputTokens = 0;
  let totalJudgeOutputTokens = 0;
  let ingestEmbedTokens = 0;
  let errorCount = 0;
  let done = 0;
  const total = questions.length - checkpoint.size;
  const startTime = Date.now();

  const processQuestion = async (q: LmeQuestion): Promise<void> => {
    if (checkpoint.has(q.id)) return;

    let modelAnswer = "";
    let answerIn = 0;
    let answerOut = 0;
    let judgeIn = 0;
    let judgeOut = 0;
    let correct = false;
    let contextTruncated = false;
    let errorMsg: string | undefined;

    try {
      // ANSWER STEP
      if (mode === "memory") {
        const memory = await opts.memoryFactory!(q.id);
        const scope: Scope = { kind: "agent", agentId: `lme:${q.id}` };
        await ingestQuestionIntoMemory(q, memory, scope);

        const retrieved = await memory.retrieve({ text: q.question, scope, topK });
        const snippets = retrieved.snippets.map((s) => s.text);
        const prompt = buildMemoryAnswerPrompt(snippets, q.question, q.questionDate);
        const resp = await answerModel.complete({
          messages: [{ role: "user", content: prompt }],
          tools: [],
        });
        const textBlocks = resp.content.filter((b) => b.type === "text") as Array<{
          type: "text";
          text: string;
        }>;
        modelAnswer = textBlocks.map((b) => b.text).join("").trim();
        answerIn = resp.usage?.inputTokens ?? 0;
        answerOut = resp.usage?.outputTokens ?? 0;
      } else {
        // full-context
        const { text, truncated } = renderHaystackCapped(q.sessions, fullContextMaxChars);
        contextTruncated = truncated;
        const prompt = buildFullContextAnswerPrompt(text, q.question, q.questionDate);
        const resp = await answerModel.complete({
          messages: [{ role: "user", content: prompt }],
          tools: [],
        });
        const textBlocks = resp.content.filter((b) => b.type === "text") as Array<{
          type: "text";
          text: string;
        }>;
        modelAnswer = textBlocks.map((b) => b.text).join("").trim();
        answerIn = resp.usage?.inputTokens ?? 0;
        answerOut = resp.usage?.outputTokens ?? 0;
      }

      // JUDGE STEP
      const judgePrompt = buildJudgePrompt(
        q.question,
        q.answer,
        modelAnswer,
        q.baseType,
        q.isAbstention,
      );
      const judgeResult = await callJudge(judgeModel, judgePrompt);
      correct = judgeResult.correct;
      judgeIn = judgeResult.inputTokens;
      judgeOut = judgeResult.outputTokens;
    } catch (err) {
      errorMsg = (err as Error).message;
      errorCount++;
      correct = false;
    }

    const appearedToAbstain = appearsToDecline(modelAnswer);

    const row: LmeQuestionResult = {
      questionId: q.id,
      questionType: q.type,
      isAbstention: q.isAbstention,
      question: q.question,
      goldAnswer: q.answer,
      modelAnswer,
      correct,
      appearedToAbstain,
      ...(contextTruncated ? { contextTruncated } : {}),
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      answerInputTokens: answerIn,
      answerOutputTokens: answerOut,
      judgeInputTokens: judgeIn,
      judgeOutputTokens: judgeOut,
    };

    results.push(row);
    totalAnswerInputTokens += answerIn;
    totalAnswerOutputTokens += answerOut;
    totalJudgeInputTokens += judgeIn;
    totalJudgeOutputTokens += judgeOut;

    if (checkpointPath) {
      await appendCheckpointRow(checkpointPath, row);
    }

    done++;
    if (onProgress) onProgress(done, total);
  };

  // Run with concurrency limit
  const concurrencyLimit = Math.max(1, concurrency);
  const pending: Promise<void>[] = [];
  for (const q of questions) {
    const p = processQuestion(q);
    pending.push(p);
    if (pending.length >= concurrencyLimit) {
      await Promise.all(pending.splice(0, concurrencyLimit));
    }
  }
  if (pending.length > 0) await Promise.all(pending);

  // Load checkpoint rows not in results (resume case)
  if (checkpointPath && checkpoint.size > 0) {
    const raw = await readFile(checkpointPath, "utf-8").catch(() => "");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as LmeQuestionResult;
        if (checkpoint.has(row.questionId)) {
          results.push(row);
          totalAnswerInputTokens += row.answerInputTokens ?? 0;
          totalAnswerOutputTokens += row.answerOutputTokens ?? 0;
          totalJudgeInputTokens += row.judgeInputTokens ?? 0;
          totalJudgeOutputTokens += row.judgeOutputTokens ?? 0;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // Compute metrics
  // byType: keyed by baseType (without _abs suffix)
  const byTypeMap: Record<string, { correct: number; total: number }> = {};
  let overallCorrect = 0;
  let overallTotal = 0;
  let abstentionCorrect = 0;
  let abstentionTotal = 0;

  for (const row of results) {
    if (row.isAbstention) {
      abstentionTotal++;
      if (row.correct) abstentionCorrect++;
    } else {
      // Derive baseType from questionType
      const bt = row.questionType.endsWith("_abs")
        ? row.questionType.slice(0, -4)
        : row.questionType;

      if (!byTypeMap[bt]) byTypeMap[bt] = { correct: 0, total: 0 };
      overallTotal++;
      if (row.correct) overallCorrect++;
      byTypeMap[bt]!.total++;
      if (row.correct) byTypeMap[bt]!.correct++;
    }
  }

  const byType: Record<string, LmeTypeStats> = {};
  for (const [t, stats] of Object.entries(byTypeMap)) {
    byType[t] = {
      ...stats,
      accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
    };
  }

  const abstentionAccuracy: LmeTypeStats | undefined =
    abstentionTotal > 0
      ? {
          correct: abstentionCorrect,
          total: abstentionTotal,
          accuracy: abstentionCorrect / abstentionTotal,
        }
      : undefined;

  const wallClockMs = Date.now() - startTime;

  const allTypes = [...new Set(questions.map((q) => q.type))].sort();

  return {
    config: {
      mode,
      topK,
      answerModelId: answerModel.modelId ?? "(unknown)",
      judgeModelId: judgeModel.modelId ?? "(unknown)",
      datasetSource: LONGMEMEVAL_SOURCE,
      seed,
      types: allTypes,
      questionsRun: results.length,
    },
    overall: {
      correct: overallCorrect,
      total: overallTotal,
      accuracy: overallTotal > 0 ? overallCorrect / overallTotal : 0,
    },
    byType,
    ...(abstentionAccuracy !== undefined ? { abstentionAccuracy } : {}),
    tokens: {
      ingestEmbedTokens,
      answerInputTokens: totalAnswerInputTokens,
      answerOutputTokens: totalAnswerOutputTokens,
      judgeInputTokens: totalJudgeInputTokens,
      judgeOutputTokens: totalJudgeOutputTokens,
      totalInputTokens: totalAnswerInputTokens + totalJudgeInputTokens,
      totalOutputTokens: totalAnswerOutputTokens + totalJudgeOutputTokens,
    },
    wallClockMs,
    questions: results,
    errorCount,
  };
}
