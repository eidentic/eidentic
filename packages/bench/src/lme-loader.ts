/**
 * LongMemEval dataset loader — real schema.
 *
 * Parses the real longmemeval_s.json (or _m / _oracle) format into typed LmeDataset.
 *
 * Dataset source:   https://github.com/xiaowu0162/LongMemEval
 * HuggingFace:      https://huggingface.co/datasets/xiaowu0162/longmemeval
 * License:          MIT — results are publishable; raw data must NOT be committed.
 *
 * LONGMEMEVAL_SOURCE below records the upstream HuggingFace dataset repo + snapshot sha
 * used when this loader was written, for provenance.
 */

import { readFile, stat } from "node:fs/promises";
import type {
  RawLmeQuestion,
  RawLmeTurn,
  LmeDataset,
  LmeQuestion,
  LmeSession,
  LmeTurn,
  LmeBaseType,
  LmeQuestionType,
} from "./lme-types.js";

/** Provenance constant for the LongMemEval dataset. */
export const LONGMEMEVAL_SOURCE = {
  url: "https://huggingface.co/datasets/xiaowu0162/longmemeval",
  snapshotSha: "2ec2a557f339b6c0369619b1ed5793734cc87533",
  file: "longmemeval_s",
  license: "MIT",
} as const;

/** Default maximum file size (512 MiB — the _s file is ~278 MiB). */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Assert that a file exists and is within the size cap before reading.
 *
 * **Security note:** callers must validate untrusted file paths before passing
 * them here — this function does not perform path traversal checks.
 */
async function assertFileSize(filePath: string, maxBytes: number): Promise<void> {
  let fileSize: number;
  try {
    const s = await stat(filePath);
    fileSize = s.size;
  } catch (err) {
    throw new Error(
      `bench loader: cannot stat file "${filePath}": ${(err as Error).message}`,
    );
  }
  if (fileSize > maxBytes) {
    const mb = (fileSize / (1024 * 1024)).toFixed(1);
    const capMb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `bench loader: file "${filePath}" is ${mb} MiB, which exceeds the ${capMb} MiB cap. ` +
      `Pass a larger maxBytes option if this is intentional.`,
    );
  }
}

/**
 * Parse a LongMemEval date-time string to epoch milliseconds.
 *
 * Observed format: "2023/05/20 (Sat) 02:36"
 * Normalise: strip the "(Weekday)" token, replace "/" separators.
 *
 * Returns 0 when parsing fails (the date is optional / informational).
 */
export function parseLmeDateTimeString(raw: string): number {
  if (!raw) return 0;
  // Remove the "(Weekday)" part: " (Sat)" → ""
  const cleaned = raw.replace(/\s*\([A-Za-z]+\)\s*/, " ").trim();
  // Replace "/" date separators with "-": "2023/05/20" → "2023-05-20"
  const iso = cleaned.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3");
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 0;
  return ms;
}

/** Extract the base type (strip "_abs" suffix if present). */
function extractBaseType(rawType: string): LmeBaseType | string {
  if (rawType.endsWith("_abs")) {
    return rawType.slice(0, -4);
  }
  return rawType;
}

/** Parse a single session (array of raw turns) into LmeSession. */
function parseSession(
  id: string,
  dateTime: string,
  rawTurns: RawLmeTurn[],
): LmeSession {
  const turns: LmeTurn[] = rawTurns.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.content ?? "",
    hasAnswer: t.has_answer === true,
  }));
  return {
    id,
    dateTime,
    dateTimeMs: parseLmeDateTimeString(dateTime),
    turns,
  };
}

/**
 * Load a LongMemEval JSON file (real schema — JSON array of questions).
 *
 * @param jsonPath  - Absolute or relative path to the longmemeval_s.json file.
 *   **Security note:** callers must validate untrusted paths before passing them here.
 * @param opts.maxBytes  - Maximum allowed file size (default 512 MiB).
 * @returns          - Typed LmeDataset with parsed sessions and questions.
 */
export async function loadLongMemEval(
  jsonPath: string,
  opts?: { maxBytes?: number },
): Promise<LmeDataset> {
  await assertFileSize(jsonPath, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8")) as unknown;

  if (!Array.isArray(raw)) {
    throw new Error(
      `bench loader: expected the LongMemEval JSON root to be an array, ` +
      `but got ${typeof raw}. Did you pass the correct file?`,
    );
  }

  const rawQuestions = raw as RawLmeQuestion[];
  const questions: LmeQuestion[] = rawQuestions.map((q, i) => {
    const id = q.question_id ?? String(i);
    const rawType: LmeQuestionType = q.question_type ?? "single-session-user";
    const baseType = extractBaseType(rawType);
    const isAbstention = rawType.endsWith("_abs");

    // Parse sessions: haystack_sessions, haystack_dates, haystack_session_ids are parallel arrays
    const rawSessions = Array.isArray(q.haystack_sessions) ? q.haystack_sessions : [];
    const dates = Array.isArray(q.haystack_dates) ? q.haystack_dates : [];
    const sessionIds = Array.isArray(q.haystack_session_ids) ? q.haystack_session_ids : [];

    const sessions: LmeSession[] = rawSessions.map((turns, idx) => {
      const sessId = sessionIds[idx] ?? `sess-${idx}`;
      const dateTime = dates[idx] ?? "";
      return parseSession(sessId, dateTime, Array.isArray(turns) ? turns : []);
    });

    // Sort sessions by dateTimeMs ascending (oldest first)
    sessions.sort((a, b) => a.dateTimeMs - b.dateTimeMs);

    return {
      id,
      type: rawType,
      baseType,
      isAbstention,
      question: q.question ?? "",
      answer: q.answer ?? "",
      questionDate: q.question_date ?? "",
      questionDateMs: parseLmeDateTimeString(q.question_date ?? ""),
      sessions,
      answerSessionIds: Array.isArray(q.answer_session_ids) ? q.answer_session_ids : [],
    };
  });

  return { questions };
}
