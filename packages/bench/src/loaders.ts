/**
 * Loaders for real benchmark datasets (LongMemEval, LoCoMo).
 *
 * These datasets are large and license-bound, so they are NOT bundled. Instead, the user
 * downloads them separately and provides a path to the JSON file. These loaders map the
 * real dataset format into BenchDataset so runMemoryBench can evaluate against them.
 *
 * GATED: only exercised by bench.live.test.ts (requires EIDENTIC_BENCH_LONGMEMEVAL or
 * EIDENTIC_BENCH_LOCOMO env vars pointing to a real dataset file).
 *
 * ─── LongMemEval ──────────────────────────────────────────────────────────────────────────────
 * Expected JSON shape (array of cases):
 * [
 *   {
 *     "session_id": "string",          // becomes BenchCase.id
 *     "conversation": [                // becomes BenchCase.turns
 *       { "role": "user" | "assistant", "content": "string", "turn_id"?: number }
 *     ],
 *     "questions": [                   // becomes BenchCase.questions
 *       {
 *         "question": "string",
 *         "answer": "string",
 *         "evidence": ["string"]       // becomes goldFacts (verbatim evidence strings)
 *       }
 *     ]
 *   }
 * ]
 * Download: https://github.com/xiaowu0162/LongMemEval (see README for dataset access)
 *
 * ─── LoCoMo ───────────────────────────────────────────────────────────────────────────────────
 * Expected JSON shape (object with a "data" array):
 * {
 *   "data": [
 *     {
 *       "conversation_id": "string",    // becomes BenchCase.id
 *       "sessions": [                   // each session contributes turns
 *         {
 *           "session_id": "string",
 *           "dialog": [
 *             { "speaker": "user" | "system", "text": "string", "timestamp"?: "string" }
 *           ]
 *         }
 *       ],
 *       "qa": [                          // becomes BenchCase.questions
 *         {
 *           "question": "string",
 *           "answer": "string",
 *           "type"?: "single-hop" | "multi-hop" | "temporal",
 *           "evidence": ["string"]
 *         }
 *       ]
 *     }
 *   ]
 * }
 * Download: https://github.com/snap-research/locomo (see paper + repo for access)
 */
import { readFile, stat } from "node:fs/promises";
import type { BenchDataset, BenchCase, BenchTurn, BenchQuestion } from "./types.js";

/** Default maximum file size (256 MiB) for benchmark dataset loaders. */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Assert that a file exists and is within the size cap before reading.
 *
 * @param filePath - Path to the file (should be validated by the caller).
 * @param maxBytes - Maximum allowed file size in bytes.  Defaults to 256 MiB.
 *
 * @throws If the file cannot be stat-ed or its size exceeds `maxBytes`.
 *
 * **Security note:** callers must validate untrusted file paths before passing
 * them here — this function does not perform path traversal checks.
 */
async function assertFileSize(filePath: string, maxBytes = DEFAULT_MAX_BYTES): Promise<void> {
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

// ── LongMemEval ───────────────────────────────────────────────────────────────────────────────

interface LMEConvTurn {
  role: "user" | "assistant";
  content: string;
  turn_id?: number;
}

interface LMEQuestion {
  question: string;
  answer?: string;
  evidence?: string[];
}

interface LMECase {
  session_id?: string;
  id?: string;
  conversation?: LMEConvTurn[];
  dialog?: LMEConvTurn[];
  questions?: LMEQuestion[];
}

/**
 * Load a LongMemEval JSON file and convert it to BenchDataset.
 *
 * @param jsonPath - Absolute or relative path to the LongMemEval JSON file.
 *   **Security note:** callers must validate untrusted paths before passing
 *   them here; this function does not perform path-traversal checks.
 * @param opts.maxBytes - Maximum allowed file size in bytes (default 256 MiB).
 *   Increase this only if you are loading a vetted, trusted dataset file.
 */
export async function loadLongMemEval(
  jsonPath: string,
  opts?: { maxBytes?: number },
): Promise<BenchDataset> {
  await assertFileSize(jsonPath, opts?.maxBytes);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8")) as unknown;
  const cases: LMECase[] = Array.isArray(raw) ? (raw as LMECase[]) : [];

  const benchCases: BenchCase[] = cases.map((c, i) => {
    const id = String(c.session_id ?? c.id ?? `lme-${i}`);
    const convArr = c.conversation ?? c.dialog ?? [];
    const turns: BenchTurn[] = convArr.map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      text: t.content,
    }));
    const questions: BenchQuestion[] = (c.questions ?? []).map((q) => ({
      question: q.question,
      goldFacts: Array.isArray(q.evidence) ? q.evidence.filter((e) => typeof e === "string") : [],
      answer: q.answer,
    }));
    return { id, turns, questions };
  });

  return { name: "LongMemEval", cases: benchCases };
}

// ── LoCoMo ────────────────────────────────────────────────────────────────────────────────────

interface LoCoMoDialog {
  speaker?: string;
  text?: string;
  timestamp?: string;
}

interface LoCoMoSession {
  session_id?: string;
  dialog?: LoCoMoDialog[];
}

interface LoCoMoQA {
  question: string;
  answer?: string;
  type?: string;
  evidence?: string[];
}

interface LoCoMoCase {
  conversation_id?: string;
  id?: string;
  sessions?: LoCoMoSession[];
  qa?: LoCoMoQA[];
}

interface LoCoMoRoot {
  data?: LoCoMoCase[];
}

function mapLoCoMoType(t?: string): BenchQuestion["category"] {
  if (!t) return undefined;
  if (t.includes("temporal")) return "temporal";
  if (t.includes("multi")) return "multi-session";
  return "single-session";
}

/**
 * Load a LoCoMo JSON file and convert it to BenchDataset.
 *
 * @param jsonPath - Absolute or relative path to the LoCoMo JSON file.
 *   **Security note:** callers must validate untrusted paths before passing
 *   them here; this function does not perform path-traversal checks.
 * @param opts.maxBytes - Maximum allowed file size in bytes (default 256 MiB).
 *   Increase this only if you are loading a vetted, trusted dataset file.
 */
export async function loadLoCoMo(
  jsonPath: string,
  opts?: { maxBytes?: number },
): Promise<BenchDataset> {
  await assertFileSize(jsonPath, opts?.maxBytes);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8")) as unknown;
  let cases: LoCoMoCase[];
  if (Array.isArray(raw)) {
    cases = raw as LoCoMoCase[];
  } else {
    const root = raw as LoCoMoRoot;
    cases = Array.isArray(root.data) ? root.data : [];
  }

  const benchCases: BenchCase[] = cases.map((c, i) => {
    const id = String(c.conversation_id ?? c.id ?? `locomo-${i}`);
    const turns: BenchTurn[] = [];
    for (const sess of c.sessions ?? []) {
      for (const d of sess.dialog ?? []) {
        const role: "user" | "assistant" = d.speaker === "system" ? "assistant" : "user";
        turns.push({
          role,
          text: d.text ?? "",
          sessionId: sess.session_id,
          ts: d.timestamp,
        });
      }
    }
    const questions: BenchQuestion[] = (c.qa ?? []).map((q) => ({
      question: q.question,
      goldFacts: Array.isArray(q.evidence) ? q.evidence.filter((e) => typeof e === "string") : [],
      answer: q.answer,
      category: mapLoCoMoType(q.type),
    }));
    return { id, turns, questions };
  });

  return { name: "LoCoMo", cases: benchCases };
}
