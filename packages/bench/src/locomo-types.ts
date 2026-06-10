/**
 * Types for the LoCoMo benchmark dataset (real schema).
 *
 * LoCoMo (Long Conversation Modeling) is a public benchmark from Snap Research:
 *   https://github.com/snap-research/locomo
 *   Dataset: CC BY-NC 4.0 — results are publishable; the raw JSON must never be committed.
 *
 * Root = bare JSON array of samples. Sessions are stored as dynamic keys session_N /
 * session_N_date_time in the conversation object.
 */

// ── Raw JSON shapes (private to the loader) ─────────────────────────────────

/** One turn inside a session array. */
export interface RawLocomoTurn {
  speaker: string;
  dia_id: string;   // e.g. "D1:9"
  text: string;
  img_url?: string;
  image_caption?: string;
}

/** One Q/A pair. Category 5 has adversarial_answer instead of answer. */
export interface RawLocomoQA {
  question: string;
  answer?: string | number;
  category: 1 | 2 | 3 | 4 | 5;
  evidence: string[];          // dia_id references, e.g. ["D1:9", "D3:2"]
  adversarial_answer?: string;
}

/** The conversation object. Keys are dynamic: speaker_a/b + session_N + session_N_date_time. */
export interface RawLocomoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: unknown;      // session_1, session_1_date_time, session_2, ...
}

/** One sample in the dataset. */
export interface RawLocomoSample {
  sample_id: string;
  conversation: RawLocomoConversation;
  qa: RawLocomoQA[];
  /** Auxiliary – not used for scoring. */
  observation?: unknown;
  session_summary?: unknown;
  event_summary?: unknown;
}

// ── Typed output shapes (public) ────────────────────────────────────────────

/** One turn parsed from a session. */
export interface LocomoTurn {
  speaker: string;
  diaId: string;
  text: string;
}

/** One session parsed from the conversation object. */
export interface LocomoSession {
  /** 1-based session index from the dataset key. */
  index: number;
  /** Human-readable date-time string from the dataset, e.g. "1:56 pm on 8 May, 2023". */
  dateTime: string;
  /** Epoch milliseconds parsed from dateTime (0 when parse fails). */
  dateTimeMs: number;
  turns: LocomoTurn[];
}

/**
 * Category definitions:
 *  1 = multi-hop (282 questions)
 *  2 = temporal  (321 questions)
 *  3 = open-domain (96 questions)
 *  4 = single-hop (841 questions)
 *  5 = adversarial/unanswerable (446 questions)
 *
 * NOTE: the numeric → semantic mapping above comes from the actual file counts.
 * Primary score = categories 1–4 (denominator 1540). Category 5 is scored separately as refusal rate.
 */
export type LocomoCategory = 1 | 2 | 3 | 4 | 5;

/** One QA pair with typed evidence references. */
export interface LocomoQA {
  question: string;
  /** Gold answer (string or number). Absent for category-5 (adversarial) questions. */
  answer?: string;
  category: LocomoCategory;
  /** Dia-id references into the conversation sessions, e.g. ["D1:9", "D3:2"]. */
  evidence: string[];
  /** The trap answer for category 5 — a plausible-sounding but wrong answer. */
  adversarialAnswer?: string;
}

/** One LoCoMo sample with parsed sessions and QA. */
export interface LocomoSample {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  sessions: LocomoSession[];
  qa: LocomoQA[];
}

/** Typed dataset returned by loadLoCoMo. */
export interface LocomoDataset {
  samples: LocomoSample[];
}

/**
 * Resolve evidence dia-ids to their actual turn texts.
 *
 * @param sample  - The LoCoMo sample.
 * @param diaIds  - Array of dia-id strings, e.g. ["D1:9", "D3:2"].
 * @returns       - Array of matched turn texts (unmatched ids are silently skipped).
 */
export function resolveEvidence(sample: LocomoSample, diaIds: string[]): string[] {
  // Build a flat map from dia_id to turn on first call; create inline here for simplicity.
  const turnMap = new Map<string, LocomoTurn>();
  for (const sess of sample.sessions) {
    for (const turn of sess.turns) {
      turnMap.set(turn.diaId, turn);
    }
  }
  const results: string[] = [];
  for (const id of diaIds) {
    const t = turnMap.get(id);
    if (t) results.push(t.text);
  }
  return results;
}
