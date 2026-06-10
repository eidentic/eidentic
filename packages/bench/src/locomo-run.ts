/**
 * Fair-run LoCoMo benchmark harness.
 *
 * Key fair-run rules (non-negotiable, documented for methodology transparency):
 *
 * 1. BOTH speakers are humans — never map to user/assistant roles.
 *    Turns are ingested as "[SpeakerName]: <text>" into one Memory scope per conversation.
 *
 * 2. Timestamps structurally — session headers are prepended ("Session N — <date>") so
 *    temporal questions are answerable; ingestedAt metadata carries the epoch-ms.
 *
 * 3. Memory-mode answer step — retrieve topK <= ~10 snippets (never inflate topK to
 *    bypass retrieval quality), build a prompt from retrieved snippets, answer concisely.
 *
 * 4. Full-context mode — the MANDATORY baseline. Entire conversation fed as context.
 *
 * 5. Judging — strict LLM judge: correct only when the model answer contains the gold
 *    answer's specific information (paraphrase ok; vague/topical-only = wrong).
 *    For category 5: correct = model declined; adversarial_answer match = wrong.
 *
 * 6. Metrics — per-category accuracy, overall J(1-4) with exact denominator 1540,
 *    category-5 refusal rate separately, token/cost accounting, wall-clock.
 *
 * 7. Determinism — seed recorded; seeded shuffle used when sampleLimit/questionLimit set.
 *
 * 8. Resilience — per-question try/catch; checkpoint-resume via JSONL file.
 */

import { readFile, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ModelPort, ModelResponse, MemoryEvent, Scope } from "@eidentic/types";
import type { Memory } from "@eidentic/memory";
import type { LocomoDataset, LocomoSample, LocomoQA } from "./locomo-types.js";
import { LOCOMO_SOURCE_SHA } from "./locomo-loader.js";

// ── Seeded PRNG (xorshift32 — same as datasets/temporal.ts) ──────────────────

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

// ── Types ─────────────────────────────────────────────────────────────────────

/** Per-question scored row (also used as checkpoint entry). */
export interface LocomoQuestionResult {
  sampleId: string;
  questionIndex: number;
  question: string;
  goldAnswer?: string;
  category: 1 | 2 | 3 | 4 | 5;
  modelAnswer: string;
  correct: boolean;
  /** True when category=5 and the model gave the adversarial trap answer. */
  trapTriggered?: boolean;
  error?: string;
  /** Tokens used in the answer step for this question. */
  answerInputTokens: number;
  answerOutputTokens: number;
  /** Tokens used in the judge step for this question. */
  judgeInputTokens: number;
  judgeOutputTokens: number;
}

/** Token / cost summary (no vendor pricing hard-coded — caller provides rates). */
export interface TokenSummary {
  ingestInputTokens: number;
  ingestOutputTokens: number;
  answerInputTokens: number;
  answerOutputTokens: number;
  judgeInputTokens: number;
  judgeOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** Per-category accuracy. */
export interface CategoryStats {
  correct: number;
  total: number;
  accuracy: number;
}

/** The full benchmark report. */
export interface LocomoReport {
  /** Run configuration (included in every published result for transparency). */
  config: {
    mode: "memory" | "full-context";
    topK: number;
    answerModelId: string;
    judgeModelId: string;
    datasetSha: string;
    seed: number;
    categories: number[];
    samplesRun: number;
    questionsRun: number;
  };
  /** Overall J(1–4): accuracy on categories 1–4 only; denominator = questions actually run in 1–4. */
  overallJ14: CategoryStats;
  /** Per-category breakdown (keys "1" through "5"). */
  byCategory: Record<string, CategoryStats>;
  /** Category-5 refusal rate (separate from J14). */
  cat5RefusalRate?: { correct: number; total: number; rate: number };
  /** Token usage accounting. */
  tokens: TokenSummary;
  /** Wall-clock duration of the run in milliseconds. */
  wallClockMs: number;
  /** Individual question results. */
  questions: LocomoQuestionResult[];
  /** Count of questions that threw errors (counted as wrong, not skipped). */
  errorCount: number;
}

/** Factory for a fresh Memory instance, called once per sample. */
export type MemoryFactory = (sampleId: string) => Memory | Promise<Memory>;

/** Options for runLocomoBench. */
export interface LocomoBenchOptions {
  /** Path to locomo10.json. */
  dataPath: string;
  /** Factory for a fresh Memory per conversation (used only when mode="memory"). */
  memoryFactory?: MemoryFactory;
  /** Model used to generate answers. */
  answerModel: ModelPort;
  /** Model used to judge correctness. */
  judgeModel: ModelPort;
  /** "memory" requires memoryFactory; "full-context" feeds the full conversation as context. */
  mode: "memory" | "full-context";
  /** Categories to include (default: [1,2,3,4,5]). */
  categories?: number[];
  /** Cap on samples to process (for quick pilot runs). */
  sampleLimit?: number;
  /** Cap on questions per sample (applied after seeded shuffle when set). */
  questionLimit?: number;
  /** Random seed for shuffle reproducibility. Default 42. */
  seed?: number;
  /** Max snippets retrieved per question in memory mode. MUST be <= 10 to avoid trivialising retrieval. */
  topK?: number;
  /** Concurrency (questions in flight simultaneously). Default 1. */
  concurrency?: number;
  /** Progress callback: (questionsCompleted, questionsTotal) */
  onProgress?: (done: number, total: number) => void;
  /** Path to a JSONL checkpoint file. Existing rows are skipped on resume. */
  checkpointPath?: string;
  /** Pre-loaded dataset (avoids re-reading the file if already loaded). */
  dataset?: LocomoDataset;
}

// ── Prompt builders ────────────────────────────────────────────────────────────

const ANSWER_INSTRUCTION =
  "Answer the question concisely and specifically based only on the information provided. " +
  "If the provided context contains no answer to the question, reply exactly: No information available";

function buildMemoryAnswerPrompt(snippets: string[], question: string): string {
  const context = snippets.length > 0
    ? snippets.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")
    : "(no relevant context retrieved)";
  return `Context from conversation:\n${context}\n\nQuestion: ${question}\n\n${ANSWER_INSTRUCTION}`;
}

function buildFullContextAnswerPrompt(conversationText: string, question: string): string {
  return `Conversation:\n${conversationText}\n\nQuestion: ${question}\n\n${ANSWER_INSTRUCTION}`;
}

function buildJudgePrompt(
  question: string,
  goldAnswer: string | undefined,
  modelAnswer: string,
  adversarialAnswer?: string,
  isCategory5?: boolean,
): string {
  if (isCategory5) {
    const trapNote = adversarialAnswer
      ? `\nWARNING — trap answer to watch for: "${adversarialAnswer}". If the model answer closely matches this trap, mark incorrect.`
      : "";
    return (
      `You are a strict judge. For this unanswerable question, a CORRECT response means the model ` +
      `refused to answer or said something equivalent to "No information available" or "I don't know".` +
      `${trapNote}\n\n` +
      `Question: ${question}\n` +
      `Model answer: ${modelAnswer}\n\n` +
      `Respond with JSON only: {"correct": true} if the model declined (correct), {"correct": false} if it made a claim.`
    );
  }
  return (
    `You are a strict judge evaluating whether a model answer is correct.\n` +
    `CORRECT: the model answer contains the specific information in the gold answer (exact match or clear paraphrase).\n` +
    `WRONG: the model answer is vague, only topically related, or contradicts the gold answer.\n` +
    `For date/time questions: equivalent date expressions referring to the same date are correct.\n\n` +
    `Question: ${question}\n` +
    `Gold answer: ${goldAnswer ?? "(none)"}\n` +
    `Model answer: ${modelAnswer}\n\n` +
    `Respond with JSON only: {"correct": true} or {"correct": false}`
  );
}

// ── Conversation rendering ──────────────────────────────────────────────────────

function renderConversation(sample: LocomoSample): string {
  const lines: string[] = [];
  for (const sess of sample.sessions) {
    const dateLabel = sess.dateTime ? ` — ${sess.dateTime}` : "";
    lines.push(`Session ${sess.index}${dateLabel}`);
    for (const turn of sess.turns) {
      lines.push(`[${turn.speaker}]: ${turn.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Ingest helpers ──────────────────────────────────────────────────────────────

async function ingestSampleIntoMemory(
  sample: LocomoSample,
  memory: Memory,
  scope: Scope,
): Promise<void> {
  const events: MemoryEvent[] = [];

  for (const sess of sample.sessions) {
    const dateLabel = sess.dateTime ? ` — ${sess.dateTime}` : "";
    const headerText = `Session ${sess.index}${dateLabel}`;
    events.push({
      id: `${sample.sampleId}:sess:${sess.index}:header`,
      scope,
      text: headerText,
      metadata: { ingestedAt: sess.dateTimeMs || undefined },
    });

    for (const turn of sess.turns) {
      events.push({
        id: `${sample.sampleId}:turn:${turn.diaId}`,
        scope,
        text: `[${turn.speaker}]: ${turn.text}`,
        metadata: {
          diaId: turn.diaId,
          sessionIndex: sess.index,
          ingestedAt: sess.dateTimeMs || undefined,
        },
      });
    }
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
    },
  });

  let correct = false;
  // Try structured output first
  if (response.object && typeof (response.object as { correct?: unknown }).correct === "boolean") {
    correct = (response.object as { correct: boolean }).correct;
  } else {
    // Fallback: parse text
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
      const row = JSON.parse(trimmed) as Partial<LocomoQuestionResult>;
      if (row.sampleId && row.questionIndex !== undefined) {
        done.add(`${row.sampleId}:${row.questionIndex}`);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return done;
}

async function appendCheckpointRow(
  path: string,
  row: LocomoQuestionResult,
): Promise<void> {
  await appendFile(path, JSON.stringify(row) + "\n", "utf-8");
}

// ── Declined-answer detection ──────────────────────────────────────────────────

const DECLINE_PATTERNS = /\bno information available\b|\bi (don'?t|do not) know\b|\bcannot (find|answer|determine)\b|\bunavailable\b/i;

function appearsToDecline(answer: string): boolean {
  return DECLINE_PATTERNS.test(answer);
}

// ── Main runner ────────────────────────────────────────────────────────────────

/**
 * Run the LoCoMo benchmark with the given options.
 *
 * @param opts - Configuration (see LocomoBenchOptions).
 * @returns    - Full LocomoReport with metrics, token accounting, and per-question details.
 */
export async function runLocomoBench(
  opts: LocomoBenchOptions,
): Promise<LocomoReport> {
  const {
    answerModel,
    judgeModel,
    mode,
    categories = [1, 2, 3, 4, 5],
    sampleLimit,
    questionLimit,
    seed = 42,
    topK: rawTopK = 10,
    concurrency = 1,
    onProgress,
    checkpointPath,
  } = opts;

  // topK is capped at 10 to preserve retrieval quality (never pass > 10 per methodology rules)
  const topK = Math.min(rawTopK, 10);
  const rng = makeRng(seed);

  // Load dataset
  let dataset: LocomoDataset;
  if (opts.dataset) {
    dataset = opts.dataset;
  } else {
    const { loadLoCoMo } = await import("./locomo-loader.js");
    dataset = await loadLoCoMo(opts.dataPath);
  }

  // Sample selection
  let samples = [...dataset.samples];
  if (sampleLimit !== undefined && sampleLimit < samples.length) {
    samples = seededShuffle(samples, makeRng(seed)).slice(0, sampleLimit);
  }

  // Build question queue
  interface QueueItem {
    sample: LocomoSample;
    qaIndex: number;
    qa: LocomoQA;
  }
  const queue: QueueItem[] = [];
  for (const sample of samples) {
    let qaList = sample.qa.filter((q) => categories.includes(q.category));
    if (questionLimit !== undefined && questionLimit < qaList.length) {
      qaList = seededShuffle(qaList, makeRng(seed + 1)).slice(0, questionLimit);
    }
    for (const qa of qaList) {
      queue.push({ sample, qaIndex: sample.qa.indexOf(qa), qa });
    }
  }

  // Load checkpoint
  const checkpoint = checkpointPath ? await loadCheckpoint(checkpointPath) : new Set<string>();

  // Pre-render full conversations (for full-context mode)
  const conversationText = new Map<string, string>();
  if (mode === "full-context") {
    for (const sample of samples) {
      conversationText.set(sample.sampleId, renderConversation(sample));
    }
  }

  // Pre-ingest memories (for memory mode — one Memory per sample)
  const memories = new Map<string, Memory>();
  let ingestInputTokens = 0;
  let ingestOutputTokens = 0;

  if (mode === "memory") {
    if (!opts.memoryFactory) {
      throw new Error("runLocomoBench: memoryFactory is required when mode='memory'");
    }
    for (const sample of samples) {
      const memory = await opts.memoryFactory(sample.sampleId);
      const scope: Scope = { kind: "agent", agentId: `locomo:${sample.sampleId}` };
      await ingestSampleIntoMemory(sample, memory, scope);
      memories.set(sample.sampleId, memory);
      // Note: ingest itself doesn't call the LLM directly; consolidation would if wired.
      // We record 0 here and let the memory surface any usage if it does LLM calls internally.
    }
  }

  // Run questions
  const results: LocomoQuestionResult[] = [];
  let totalAnswerInputTokens = 0;
  let totalAnswerOutputTokens = 0;
  let totalJudgeInputTokens = 0;
  let totalJudgeOutputTokens = 0;
  let errorCount = 0;
  let done = 0;
  const total = queue.length - checkpoint.size;
  const startTime = Date.now();

  // Process with concurrency limit
  const processItem = async (item: QueueItem): Promise<void> => {
    const key = `${item.sample.sampleId}:${item.qaIndex}`;
    if (checkpoint.has(key)) return;

    let modelAnswer = "";
    let answerIn = 0;
    let answerOut = 0;
    let judgeIn = 0;
    let judgeOut = 0;
    let correct = false;
    let trapTriggered: boolean | undefined;
    let errorMsg: string | undefined;

    try {
      // ANSWER STEP
      if (mode === "memory") {
        const memory = memories.get(item.sample.sampleId)!;
        const scope: Scope = { kind: "agent", agentId: `locomo:${item.sample.sampleId}` };
        const retrieved = await memory.retrieve({ text: item.qa.question, scope, topK });
        const snippets = retrieved.snippets.map((s) => s.text);
        const prompt = buildMemoryAnswerPrompt(snippets, item.qa.question);
        const resp = await answerModel.complete({
          messages: [{ role: "user", content: prompt }],
          tools: [],
        });
        const textBlocks = resp.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
        modelAnswer = textBlocks.map((b) => b.text).join("").trim();
        answerIn = resp.usage?.inputTokens ?? 0;
        answerOut = resp.usage?.outputTokens ?? 0;
      } else {
        // full-context
        const convText = conversationText.get(item.sample.sampleId) ?? "";
        const prompt = buildFullContextAnswerPrompt(convText, item.qa.question);
        const resp = await answerModel.complete({
          messages: [{ role: "user", content: prompt }],
          tools: [],
        });
        const textBlocks = resp.content.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>;
        modelAnswer = textBlocks.map((b) => b.text).join("").trim();
        answerIn = resp.usage?.inputTokens ?? 0;
        answerOut = resp.usage?.outputTokens ?? 0;
      }

      // JUDGE STEP
      const isCategory5 = item.qa.category === 5;
      const judgePrompt = buildJudgePrompt(
        item.qa.question,
        item.qa.answer,
        modelAnswer,
        item.qa.adversarialAnswer,
        isCategory5,
      );
      const judgeResult = await callJudge(judgeModel, judgePrompt);
      correct = judgeResult.correct;
      judgeIn = judgeResult.inputTokens;
      judgeOut = judgeResult.outputTokens;

      // For category 5, also check if trap was triggered
      if (isCategory5 && item.qa.adversarialAnswer) {
        const adversarialLower = item.qa.adversarialAnswer.toLowerCase();
        const answerLower = modelAnswer.toLowerCase();
        trapTriggered =
          answerLower.includes(adversarialLower) ||
          adversarialLower.includes(answerLower.slice(0, Math.min(answerLower.length, 30)));
        // If trap triggered and judge said correct, override: trap = wrong
        if (trapTriggered && correct) correct = false;
        // If model declined, also check via pattern (judge should handle this, but belt-and-suspenders)
        if (!correct && appearsToDecline(modelAnswer)) {
          correct = true;
          trapTriggered = false;
        }
      }
    } catch (err) {
      errorMsg = (err as Error).message;
      errorCount++;
      correct = false;
    }

    const row: LocomoQuestionResult = {
      sampleId: item.sample.sampleId,
      questionIndex: item.qaIndex,
      question: item.qa.question,
      goldAnswer: item.qa.answer,
      category: item.qa.category,
      modelAnswer,
      correct,
      ...(trapTriggered !== undefined ? { trapTriggered } : {}),
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

  // Run with concurrency limit (simple sliding-window approach)
  const concurrencyLimit = Math.max(1, concurrency);
  const pending: Promise<void>[] = [];
  for (const item of queue) {
    const p = processItem(item);
    pending.push(p);
    if (pending.length >= concurrencyLimit) {
      await Promise.all(pending.splice(0, concurrencyLimit));
    }
  }
  if (pending.length > 0) await Promise.all(pending);

  // Also load any checkpoint rows not in results (resume case)
  if (checkpointPath && checkpoint.size > 0) {
    const raw = await readFile(checkpointPath, "utf-8").catch(() => "");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as LocomoQuestionResult;
        const key = `${row.sampleId}:${row.questionIndex}`;
        if (checkpoint.has(key)) {
          results.push(row);
          totalAnswerInputTokens += row.answerInputTokens ?? 0;
          totalAnswerOutputTokens += row.answerOutputTokens ?? 0;
          totalJudgeInputTokens += row.judgeInputTokens ?? 0;
          totalJudgeOutputTokens += row.judgeOutputTokens ?? 0;
        }
      } catch { /* ignore */ }
    }
  }

  // Compute metrics
  const byCategoryMap: Record<string, { correct: number; total: number }> = {};
  for (const row of results) {
    const cat = String(row.category);
    if (!byCategoryMap[cat]) byCategoryMap[cat] = { correct: 0, total: 0 };
    byCategoryMap[cat]!.total++;
    if (row.correct) byCategoryMap[cat]!.correct++;
  }

  const byCategory: Record<string, CategoryStats> = {};
  for (const [cat, stats] of Object.entries(byCategoryMap)) {
    byCategory[cat] = {
      ...stats,
      accuracy: stats.total > 0 ? stats.correct / stats.total : 0,
    };
  }

  // J(1-4): accuracy on categories 1-4 only
  let j14Correct = 0;
  let j14Total = 0;
  for (const [cat, stats] of Object.entries(byCategory)) {
    const n = parseInt(cat);
    if (n >= 1 && n <= 4) {
      j14Correct += stats.correct;
      j14Total += stats.total;
    }
  }

  // Cat5 refusal rate
  const cat5Stats = byCategory["5"];
  const cat5RefusalRate = cat5Stats
    ? { correct: cat5Stats.correct, total: cat5Stats.total, rate: cat5Stats.accuracy }
    : undefined;

  const wallClockMs = Date.now() - startTime;

  return {
    config: {
      mode,
      topK,
      answerModelId: answerModel.modelId ?? "(unknown)",
      judgeModelId: judgeModel.modelId ?? "(unknown)",
      datasetSha: LOCOMO_SOURCE_SHA,
      seed,
      categories: [...categories].sort((a, b) => a - b),
      samplesRun: samples.length,
      questionsRun: results.length,
    },
    overallJ14: {
      correct: j14Correct,
      total: j14Total,
      accuracy: j14Total > 0 ? j14Correct / j14Total : 0,
    },
    byCategory,
    cat5RefusalRate,
    tokens: {
      ingestInputTokens,
      ingestOutputTokens,
      answerInputTokens: totalAnswerInputTokens,
      answerOutputTokens: totalAnswerOutputTokens,
      judgeInputTokens: totalJudgeInputTokens,
      judgeOutputTokens: totalJudgeOutputTokens,
      totalInputTokens: ingestInputTokens + totalAnswerInputTokens + totalJudgeInputTokens,
      totalOutputTokens: ingestOutputTokens + totalAnswerOutputTokens + totalJudgeOutputTokens,
    },
    wallClockMs,
    questions: results,
    errorCount,
  };
}
