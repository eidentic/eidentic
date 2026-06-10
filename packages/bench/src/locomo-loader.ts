/**
 * LoCoMo dataset loader — real schema.
 *
 * The real locomo10.json root is a bare JSON array of samples. Sessions are stored as dynamic
 * keys session_N / session_N_date_time in the conversation object (not a nested array).
 *
 * Dataset source: https://github.com/snap-research/locomo
 * License: CC BY-NC 4.0 — raw data must NOT be committed; results are publishable.
 *
 * LOCOMO_SOURCE_SHA below records the upstream commit that produced the locomo10.json file
 * used in this implementation, for provenance.
 */

import { readFile, stat } from "node:fs/promises";
import type {
  RawLocomoSample,
  RawLocomoTurn,
  RawLocomoConversation,
} from "./locomo-types.js";
import type {
  LocomoDataset,
  LocomoSample,
  LocomoSession,
  LocomoQA,
  LocomoTurn,
} from "./locomo-types.js";

/** Upstream commit SHA of snap-research/locomo at the time the loader was written. */
export const LOCOMO_SOURCE_SHA = "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376";

/** Default maximum file size (256 MiB). */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

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
 * Parse a LoCoMo date-time string to epoch milliseconds.
 *
 * Observed formats:
 *   "1:56 pm on 8 May, 2023"
 *   "10:37 am on 27 June, 2023"
 *
 * Returns 0 when parsing fails (the date is optional / informational).
 */
function parseLocomoDateTime(raw: string): number {
  // Normalise: remove "on " and strip extra whitespace
  const cleaned = raw.replace(/\s*on\s+/, " ").trim();
  const ms = Date.parse(cleaned);
  if (Number.isNaN(ms)) {
    // Fallback: try reordering "1:56 pm 8 May, 2023" → "8 May, 2023 1:56 pm"
    const match = /^(\d{1,2}:\d{2}\s*(?:am|pm))\s+(.+)$/i.exec(cleaned);
    if (match) {
      const ms2 = Date.parse(`${match[2]!} ${match[1]!}`);
      return Number.isNaN(ms2) ? 0 : ms2;
    }
    return 0;
  }
  return ms;
}

/** Parse dynamic session keys from a conversation object. */
function parseSessions(conv: RawLocomoConversation): LocomoSession[] {
  // Collect all session indices (keys like "session_1", "session_2", …).
  const indices: number[] = [];
  for (const key of Object.keys(conv)) {
    const m = /^session_(\d+)$/.exec(key);
    if (m) indices.push(parseInt(m[1]!, 10));
  }
  indices.sort((a, b) => a - b);

  const sessions: LocomoSession[] = [];
  for (const idx of indices) {
    const turnsRaw = conv[`session_${idx}`];
    if (!Array.isArray(turnsRaw)) continue;

    const dateTimeRaw = typeof conv[`session_${idx}_date_time`] === "string"
      ? (conv[`session_${idx}_date_time`] as string)
      : "";

    const turns: LocomoTurn[] = (turnsRaw as RawLocomoTurn[]).map((t) => ({
      speaker: t.speaker ?? "",
      diaId: t.dia_id ?? "",
      text: t.text ?? "",
    }));

    sessions.push({
      index: idx,
      dateTime: dateTimeRaw,
      dateTimeMs: dateTimeRaw ? parseLocomoDateTime(dateTimeRaw) : 0,
      turns,
    });
  }
  return sessions;
}

/**
 * Load a LoCoMo JSON file (real schema — bare array of samples with dynamic session keys).
 *
 * @param jsonPath  - Absolute or relative path to the locomo10.json file.
 *   **Security note:** callers must validate untrusted paths before passing them here.
 * @param opts.maxBytes  - Maximum allowed file size (default 256 MiB).
 * @returns          - Typed LocomoDataset with parsed sessions and QA.
 */
export async function loadLoCoMo(
  jsonPath: string,
  opts?: { maxBytes?: number },
): Promise<LocomoDataset> {
  await assertFileSize(jsonPath, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  const raw = JSON.parse(await readFile(jsonPath, "utf-8")) as unknown;

  if (!Array.isArray(raw)) {
    throw new Error(
      `bench loader: expected the LoCoMo JSON root to be an array, ` +
      `but got ${typeof raw}. Did you pass the correct file?`,
    );
  }

  const rawSamples = raw as RawLocomoSample[];
  const samples: LocomoSample[] = rawSamples.map((s, i) => {
    const sampleId = s.sample_id ?? String(i);
    const conv = s.conversation ?? ({} as RawLocomoConversation);
    const sessions = parseSessions(conv);

    const qa: LocomoQA[] = (s.qa ?? []).map((q) => {
      const answer = q.answer !== undefined ? String(q.answer) : undefined;
      return {
        question: q.question ?? "",
        answer,
        category: q.category as LocomoQA["category"],
        evidence: Array.isArray(q.evidence) ? q.evidence : [],
        adversarialAnswer: q.adversarial_answer,
      };
    });

    return {
      sampleId,
      speakerA: String(conv.speaker_a ?? ""),
      speakerB: String(conv.speaker_b ?? ""),
      sessions,
      qa,
    };
  });

  return { samples };
}
