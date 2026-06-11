/**
 * Types for the LongMemEval benchmark dataset (real schema).
 *
 * LongMemEval is a public benchmark from Wu et al.:
 *   https://github.com/xiaowu0162/LongMemEval
 *   HuggingFace: https://huggingface.co/datasets/xiaowu0162/longmemeval
 *   License: MIT — results are publishable; the raw JSON must never be committed.
 *
 * Root = JSON array of questions. Each question has a multi-session haystack.
 * Standard file: longmemeval_s.json (~500 questions, ~115k-token haystacks).
 */

// ── Raw JSON shapes (private to the loader) ──────────────────────────────────

/** One turn inside a haystack session. */
export interface RawLmeTurn {
  role: "user" | "assistant";
  content: string;
  /** Not present in longmemeval_s.json; kept optional for compatibility. */
  has_answer?: boolean;
}

/** One item in the LongMemEval JSON array. */
export interface RawLmeQuestion {
  question_id: string;
  /**
   * Type string. Base types:
   *   single-session-user | single-session-assistant | single-session-preference
   *   multi-session | temporal-reasoning | knowledge-update
   * Plus abstention variants of each (e.g. "single-session-user_abs").
   */
  question_type: string;
  question: string;
  answer: string;
  /** "2023/05/20 (Sat) 02:36" format */
  question_date: string;
  /** One entry per session, parallel to haystack_sessions. */
  haystack_dates: string[];
  /** One session id per session. */
  haystack_session_ids: string[];
  /** Each session = array of turns. */
  haystack_sessions: RawLmeTurn[][];
  /** Which session_ids contain the answer evidence. */
  answer_session_ids: string[];
}

// ── Typed output shapes (public) ─────────────────────────────────────────────

/** One turn inside a parsed session. */
export interface LmeTurn {
  role: "user" | "assistant";
  content: string;
  /** True when the turn contains the gold answer (may be absent in all turns). */
  hasAnswer: boolean;
}

/** One session inside a question's haystack. */
export interface LmeSession {
  /** The session's original id from the dataset. */
  id: string;
  /** Human-readable date-time string from the dataset, e.g. "2023/05/20 (Sat) 02:36". */
  dateTime: string;
  /** Epoch milliseconds parsed from dateTime (0 when parse fails). */
  dateTimeMs: number;
  turns: LmeTurn[];
}

/**
 * LongMemEval question types (7 base types, plus `*_abs` abstention variants).
 *
 * Base types:
 *   single-session-user           — fact stated by the user in one session
 *   single-session-assistant      — fact stated by the assistant in one session
 *   single-session-preference     — user preference expressed in one session
 *   multi-session                 — evidence spans multiple sessions
 *   temporal-reasoning            — requires reasoning about time/dates
 *   knowledge-update              — the fact was updated in a later session
 *
 * Abstention variants (append "_abs"):
 *   The correct answer is to recognize the information is not present / premise
 *   is flawed and respond with "no information" rather than fabricating an answer.
 */
export type LmeBaseType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "multi-session"
  | "temporal-reasoning"
  | "knowledge-update";

export type LmeQuestionType = LmeBaseType | `${LmeBaseType}_abs` | (string & Record<never, never>);

/** One parsed LongMemEval question with its haystack. */
export interface LmeQuestion {
  /** Original question_id from the dataset, e.g. "e47becba" or "gpt4_xxxx". */
  id: string;
  /** Full question_type string (may include "_abs" suffix). */
  type: LmeQuestionType;
  /** Base type without any "_abs" suffix. */
  baseType: LmeBaseType | string;
  /** Whether this is an abstention variant (type ends with "_abs"). */
  isAbstention: boolean;
  question: string;
  /** Gold answer string. For abstention questions, the correct response is to abstain. */
  answer: string;
  /** Human-readable question date string from the dataset. */
  questionDate: string;
  /** Epoch ms for the question date (0 when parse fails). */
  questionDateMs: number;
  /** Haystack sessions in date order. */
  sessions: LmeSession[];
  /** Session ids that contain the answer evidence. */
  answerSessionIds: string[];
}

/** Typed dataset returned by loadLongMemEval (new real-schema loader). */
export interface LmeDataset {
  questions: LmeQuestion[];
}
