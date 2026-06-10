/**
 * Synthetic temporal benchmark dataset generator.
 *
 * Generates K entities with state histories (employer / city / preference changing
 * over time at known dates). Produces:
 *   - A sequence of AssertFactInput calls that establish the temporal record.
 *   - A question set "what was X's <property> at <date>?" with gold answers.
 *     Covers dates:
 *       • BETWEEN two changes (mid-interval)
 *       • AT the exact change boundary
 *       • BEFORE first known fact (expect: no answer)
 *       • AT the current/latest state
 *
 * This benchmark is ONLY passable by systems with timestamped fact validity (validAt).
 * Pure retrieval systems that do not record fact-level temporal intervals cannot pass it —
 * this distinction is documented plainly in BASELINES.md.
 *
 * The generator is seeded for determinism (seed parameter controls entity names +
 * timestamps so the same seed always produces the same question/answer pairs).
 */

import type { AssertFactInput, Scope } from "@eidentic/types";

// ── Types ──────────────────────────────────────────────────────────────────────────────────────

/** A single state transition for one entity property. */
export interface StateTransition {
  /** ISO timestamp at which this state becomes valid. */
  validFrom: string;
  /** The value of the property at this point in time. */
  value: string;
}

/** One entity with one or more tracked properties and their state history. */
export interface TemporalEntity {
  /** Stable entity name (e.g. "entity_0"). */
  name: string;
  /** Map from predicate name (e.g. "employer") to ordered history of transitions. */
  history: Record<string, StateTransition[]>;
}

/** A single point-in-time question with gold answer. */
export interface TemporalQuestion {
  subject: string;
  predicate: string;
  /** The ISO date at which the question is asked. */
  askedAt: string;
  /**
   * Gold answer: the value of the property at askedAt, or null if no fact was known
   * before askedAt (query before first known state).
   */
  goldAnswer: string | null;
  /** Human-readable description of why this answer is correct. */
  rationale: string;
}

/** The complete synthetic temporal dataset. */
export interface SyntheticTemporalDataset {
  /** Human-readable name for display. */
  name: string;
  /** Seed used to generate this dataset (for reproducibility). */
  seed: number;
  /** Generated entities with full state histories. */
  entities: TemporalEntity[];
  /**
   * AssertFactInput objects ready to be passed to memory.assertFact, in ascending
   * validFrom order. Call with the scope of your choice.
   */
  asserts: AssertFactInput[];
  /** Point-in-time QA pairs for evaluation. */
  questions: TemporalQuestion[];
}

// ── Seeded PRNG ────────────────────────────────────────────────────────────────────────────────

/**
 * Minimal seeded PRNG (xorshift32). Deterministic across all platforms.
 * Returns a float in [0, 1).
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1; // xorshift32 degenerates at 0
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s = s >>> 0;
    return s / 0x100000000;
  };
}

function rngChoice<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// ── Fixed value pools ──────────────────────────────────────────────────────────────────────────

const EMPLOYERS = [
  "Acme Corp",
  "StartupX",
  "MegaCorp",
  "HealthCo",
  "EduInc",
  "FinTechLtd",
  "RetailCo",
  "CloudSystems",
  "OpenSource Inc",
  "ConsultingGroup",
];

const CITIES = [
  "Amsterdam",
  "Berlin",
  "Toronto",
  "London",
  "Sydney",
  "Tokyo",
  "Paris",
  "Seoul",
  "Nairobi",
  "Sao Paulo",
];

const LANGUAGES = [
  "TypeScript",
  "Rust",
  "Python",
  "Go",
  "Kotlin",
  "Swift",
  "Elixir",
  "Scala",
  "Java",
  "Clojure",
];

const ROLES = [
  "junior-developer",
  "mid-developer",
  "senior-developer",
  "staff-engineer",
  "principal-engineer",
  "engineering-manager",
  "director-of-engineering",
  "vp-engineering",
  "cto",
  "founder",
];

type PropertyPool = {
  predicate: string;
  values: string[];
};

const PROPERTY_POOLS: PropertyPool[] = [
  { predicate: "employer", values: EMPLOYERS },
  { predicate: "city", values: CITIES },
  { predicate: "preferred_language", values: LANGUAGES },
  { predicate: "role", values: ROLES },
];

// ── Base timestamps ────────────────────────────────────────────────────────────────────────────

/** Generate a sequence of ISO timestamps spaced ~6 months apart starting from 2022-01-01. */
function generateTimestamps(count: number, startYear = 2022, startMonth = 1): string[] {
  const ts: string[] = [];
  let year = startYear;
  let month = startMonth;
  for (let i = 0; i < count; i++) {
    ts.push(`${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`);
    month += 6;
    if (month > 12) {
      month -= 12;
      year += 1;
    }
  }
  return ts;
}

// ── Generator ─────────────────────────────────────────────────────────────────────────────────

/**
 * Generate a synthetic temporal dataset.
 *
 * @param opts.entityCount  Number of entities (default 4).
 * @param opts.seed         Seed for determinism (default 42).
 * @param opts.changesPerProperty  Number of state changes per property per entity (default 3).
 */
export function syntheticTemporalDataset(opts: {
  entityCount?: number;
  seed?: number;
  changesPerProperty?: number;
} = {}): SyntheticTemporalDataset {
  const entityCount = opts.entityCount ?? 4;
  const seed = opts.seed ?? 42;
  const changesPerProperty = opts.changesPerProperty ?? 3;
  const rng = makeRng(seed);

  const entities: TemporalEntity[] = [];
  const asserts: AssertFactInput[] = [];
  const questions: TemporalQuestion[] = [];

  // Generate timestamps: changesPerProperty transitions per property
  const allTimestamps = generateTimestamps(changesPerProperty + 2, 2022, 1);

  for (let ei = 0; ei < entityCount; ei++) {
    const entityName = `entity_${ei}`;
    const history: Record<string, StateTransition[]> = {};

    for (const pool of PROPERTY_POOLS) {
      const transitions: StateTransition[] = [];

      // Pick unique values from the pool for this property
      const poolCopy = [...pool.values];
      // Shuffle a slice using rng
      for (let i = poolCopy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [poolCopy[i], poolCopy[j]] = [poolCopy[j]!, poolCopy[i]!];
      }

      // Pick changesPerProperty unique values
      const chosen = poolCopy.slice(0, changesPerProperty);

      for (let ci = 0; ci < changesPerProperty; ci++) {
        const validFrom = allTimestamps[ci]!;
        const value = chosen[ci]!;
        transitions.push({ validFrom, value });
        asserts.push({
          subject: entityName,
          predicate: pool.predicate,
          object: value,
          objectKind: "literal",
          confidence: 1,
          validFrom,
        });
      }

      history[pool.predicate] = transitions;
    }

    entities.push({ name: entityName, history });

    // Generate questions for this entity
    for (const pool of PROPERTY_POOLS) {
      const transitions = history[pool.predicate]!;
      if (transitions.length === 0) continue;

      // ── Q1: BEFORE first known fact ──────────────────────────────────────────────────────────
      questions.push({
        subject: entityName,
        predicate: pool.predicate,
        askedAt: "2021-01-01T00:00:00.000Z", // before the 2022 start
        goldAnswer: null,
        rationale: `No fact for ${entityName}.${pool.predicate} exists before ${transitions[0]!.validFrom}`,
      });

      // ── Q2: AT the first transition (exact boundary) ──────────────────────────────────────────
      questions.push({
        subject: entityName,
        predicate: pool.predicate,
        askedAt: transitions[0]!.validFrom,
        goldAnswer: transitions[0]!.value,
        rationale: `At exactly ${transitions[0]!.validFrom}, the first fact is active`,
      });

      // ── Q3: BETWEEN first and second change (mid-interval) ───────────────────────────────────
      if (transitions.length >= 2) {
        const t1 = new Date(transitions[0]!.validFrom).getTime();
        const t2 = new Date(transitions[1]!.validFrom).getTime();
        const midMs = Math.floor((t1 + t2) / 2);
        const midIso = new Date(midMs).toISOString().replace(/\.\d{3}Z$/, ".000Z");
        questions.push({
          subject: entityName,
          predicate: pool.predicate,
          askedAt: midIso,
          goldAnswer: transitions[0]!.value,
          rationale: `Between ${transitions[0]!.validFrom} and ${transitions[1]!.validFrom}, the first fact is still active`,
        });
      }

      // ── Q4: AT the latest/current state ──────────────────────────────────────────────────────
      const latest = transitions[transitions.length - 1]!;
      // Ask 30 days after the last transition to make it clearly "current"
      const laterMs = new Date(latest.validFrom).getTime() + 30 * 24 * 60 * 60 * 1000;
      const laterIso = new Date(laterMs).toISOString().replace(/\.\d{3}Z$/, ".000Z");
      questions.push({
        subject: entityName,
        predicate: pool.predicate,
        askedAt: laterIso,
        goldAnswer: latest.value,
        rationale: `After the last transition at ${latest.validFrom}, the latest fact is active`,
      });
    }
  }

  return {
    name: `eidentic-temporal-synthetic-v1 (seed=${seed}, entities=${entityCount})`,
    seed,
    entities,
    asserts,
    questions,
  };
}
