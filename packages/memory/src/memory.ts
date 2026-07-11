import {
  addUsage,
  legacyScopeKey,
  scopeKey,
  tokenize,
  isToolUse,
  defaultConsentClassifier,
  type BlockEdit, type EditableMemoryPort, type RetrievalQuery, type RetrievedMemory,
  type MemoryEvent, type MemoryBlock, type Scope, type StorePort,
  type VectorPort, type EmbeddingPort, type RerankPort, type MemorySnippet, type VectorSearchResult,
  type GraphPort, type AssertFactInput, type FactQuery, type Fact,
  type ModelPort, type Usage, type ToolSchema, type VectorEntry,
  type ConsentManifest, type ConsentResult, type ConsentPolicy, type MemoryExport,
} from "@eidentic/types";

/**
 * Derive a stable subject string from a MemoryEvent for passive fact extraction (Fix §6.8 multi-tenant).
 * Priority: event.subject (caller-supplied) > scope-derived token.
 * For `user` scope, uses userId (the most precise per-user identity available in scope).
 * For other scopes (agent, thread, org, shared) falls back to a stable scope-derived token so facts
 * from different scopes at least don't collide — though for org/shared the caller SHOULD pass event.subject.
 */
function subjectForEvent(event: MemoryEvent): string {
  if (event.subject !== undefined) return event.subject;
  const s = event.scope;
  if (s.kind === "user") return s.userId;
  if (s.kind === "agent") return s.agentId;
  if (s.kind === "thread") return `thread:${s.sessionId}`;
  if (s.kind === "org") return `org:${s.orgId}`;
  // shared scope: no per-user identity available; use the block id as a stable but non-user token
  return `shared:${s.blockId}`;
}

function memoryCacheKey(scopeKeyValue: string, id: string): string {
  return JSON.stringify([scopeKeyValue, id]);
}

function memoryCacheOwner(key: string): { scopeKey: string; id: string } | null {
  try {
    const value = JSON.parse(key) as unknown;
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== "string" || typeof value[1] !== "string") return null;
    return { scopeKey: value[0], id: value[1] };
  } catch {
    return null;
  }
}
import { reciprocalRankFusion } from "./rrf.js";
import { BlockEditor, type BlockSpec } from "./blocks.js";
import { passiveExtract } from "./passive.js";

/**
 * Check whether a text contains any transient temporal marker from `TRANSIENT_MARKERS`.
 * Case-insensitive whole-word (boundary) match to avoid false positives inside longer words.
 */
function hasTransientMarker(text: string): boolean {
  const lower = text.toLowerCase();
  for (const marker of TRANSIENT_MARKERS) {
    const idx = lower.indexOf(marker);
    if (idx === -1) continue;
    // word-boundary check: preceding char must be non-alpha-or-start, following char must be non-alpha-or-end
    const before = idx === 0 ? true : !/[a-z]/.test(lower[idx - 1]!);
    const after = idx + marker.length >= lower.length ? true : !/[a-z]/.test(lower[idx + marker.length]!);
    if (before && after) return true;
  }
  return false;
}

/**
 * Rule-based entity extraction for the retrieval entity signal (improvement 6).
 * Extracts:
 *   1. Capitalised multi-word sequences (e.g. "New York Times", "Eiffel Tower")
 *   2. Quoted strings (single or double)
 *   3. Email addresses
 *   4. @handles
 * Returns a de-duplicated, lowercased array of candidate entity strings.
 */
function extractQueryEntities(text: string): string[] {
  const entities = new Set<string>();

  // 1. Capitalised multi-word sequences (2+ consecutive Title-Case tokens)
  const capPattern = /(?:[A-Z][a-zA-Z\-']+)(?:\s+[A-Z][a-zA-Z\-']+)+/g;
  for (const m of text.matchAll(capPattern)) {
    entities.add(m[0]!.toLowerCase());
  }
  // Also single capitalised words not at sentence start (preceded by a space)
  const singleCap = /(?<=\s)([A-Z][a-zA-Z\-']{2,})/g;
  for (const m of text.matchAll(singleCap)) {
    entities.add(m[1]!.toLowerCase());
  }

  // 2. Quoted strings (single or double quotes, at least 2 chars)
  const quoted = /["']([^"']{2,})["']/g;
  for (const m of text.matchAll(quoted)) {
    entities.add(m[1]!.trim().toLowerCase());
  }

  // 3. Email addresses
  const emails = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g;
  for (const m of text.matchAll(emails)) {
    entities.add(m[0]!.toLowerCase());
  }

  // 4. @handles
  const handles = /@([a-zA-Z0-9_]{2,})/g;
  for (const m of text.matchAll(handles)) {
    entities.add(`@${m[1]!.toLowerCase()}`);
  }

  return [...entities];
}

const MERGE_PASSAGES_TOOL: ToolSchema = {
  name: "merge_passages",
  description:
    "Merge two near-duplicate archival passages into ONE canonical passage. The result must be " +
    "grounded in and derived from the two inputs only — preserve every distinct fact, drop the " +
    "redundancy, invent nothing new.",
  inputSchema: {
    type: "object",
    properties: { passage: { type: "string", description: "the single canonical merged passage" } },
    required: ["passage"],
  },
};
const MERGE_SYSTEM =
  "You are a memory consolidation agent performing archival dedup (§6.5). You are given two " +
  "near-duplicate passages. Produce ONE canonical passage that preserves all distinct information " +
  "and removes the redundancy. Ground it strictly in the two inputs; do not invent. " +
  "Call merge_passages exactly once with the canonical passage.";

/** Cosine similarity of two equal-length vectors. Self-contained (the testing fake's copy is private). */
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; ma += a[i]! * a[i]!; mb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };
/** Hard default ceiling for one archival-dedup pass (50M pairs at 10k entries is not acceptable). */
const DEFAULT_DEDUPE_COMPARISON_BUDGET = 100_000;
const DEFAULT_DEDUPE_MERGE_BUDGET = 100;
const DEFAULT_DEDUPE_MERGE_TOKEN_BUDGET = 100_000;
// addUsage is imported from @eidentic/types (canonical shared implementation).

/**
 * Candidate ordering for archival dedup.
 *
 * Small/exhaustive passes retain the historical `(i, j)` ordering exactly. Budgeted passes compare
 * every adjacent pair before widening the index distance, so work is spread across the whole scope
 * rather than spending the entire budget on the first few entries.
 */
function* dedupePairIndices(entryCount: number, budgeted: boolean): Generator<readonly [number, number]> {
  if (!budgeted) {
    for (let i = 0; i < entryCount; i++) {
      for (let j = i + 1; j < entryCount; j++) yield [i, j] as const;
    }
    return;
  }
  for (let distance = 1; distance < entryCount; distance++) {
    for (let i = 0; i + distance < entryCount; i++) yield [i, i + distance] as const;
  }
}

export interface DedupeOptions {
  /** Cosine similarity at/above which two passages are treated as near-duplicates. Default 0.95. */
  threshold?: number;
  /** The (slow, capable) model that produces the canonical merged passage. No model ⇒ no-op. */
  mergeModel?: ModelPort;
  /** @deprecated This option has no effect and will be removed in the next major version. */
  now?: () => string;
  /**
   * Hard ceiling on candidate-pair work in one pass. Default 100,000. `0` performs no comparisons.
   * Raise deliberately for an offline maintenance window; the result reports when this truncates a
   * pass so callers can partition the scope or schedule another pass.
   */
  maxComparisons?: number;
  /** Hard ceiling on successful LLM merges in one pass. Default 100. */
  maxMerges?: number;
  /** Hard cumulative input+output token budget for merge calls. Default 100,000. */
  maxMergeTokens?: number;
  /** Cancels candidate scanning and is forwarded to merge-model calls. */
  signal?: AbortSignal;
}
export interface DedupeResult {
  /** Number of duplicate passages merged away (collapsed into a canonical). */
  merged: number;
  /** Aggregated usage of every merge LLM call — account to cost.background (§6.5 transparency). */
  usage: Usage;
  /** Cosine comparisons actually performed. Present when a vector scan was attempted. */
  comparisons?: number;
  /** Candidate pair slots examined, including pairs skipped because one entry was already merged. */
  candidatePairsExamined?: number;
  /** Configured hard ceiling for candidate-pair work in this pass. */
  comparisonBudget?: number;
  /** Theoretical all-pairs count at the start of the pass. */
  totalPairs?: number;
  /** True when unexamined candidate pairs remained because `comparisonBudget` was reached. */
  truncated?: boolean;
  /** Configured successful-merge ceiling for this pass. */
  mergeBudget?: number;
  /** Configured cumulative merge-token ceiling for this pass. */
  mergeTokenBudget?: number;
}

/**
 * Optional recency-weighted ranking configuration for `Memory.retrieve`.
 *
 * When set, the final ranked list is re-scored by blending normalized semantic/lexical
 * similarity with an exponential age-decay term so that newer memories can rank higher.
 *
 * Combined score formula:
 *   score = (1 - weight) * normalizedSimilarity + weight * exp(-ln(2) * ageMs / halfLifeMs)
 *
 * where:
 *   - `normalizedSimilarity` is the snippet's similarity score linearly normalized to [0, 1]
 *     across the candidate set (scale-invariant across different retrieval back-ends).
 *   - `ageMs` = now() - ingestedAt (ms); clamped to ≥ 0 for future-dated entries.
 *   - `exp(-ln(2) * ageMs / halfLifeMs)` is the recency factor: 1 at age 0, 0.5 at age
 *     halfLifeMs, 0.25 at age 2×halfLifeMs, and so on.
 *   - `weight` controls how much recency contributes (default 0.3 → 30 % recency, 70 % similarity).
 *
 * OFF by default: omit this option entirely for the pure-similarity behavior that existed before.
 */
export interface RecencyOptions {
  /**
   * Half-life of the recency decay in milliseconds. After `halfLifeMs` the recency factor
   * drops to 0.5; after `2 × halfLifeMs` it drops to 0.25, and so on.
   *
   * Example values:
   *   3_600_000        (1 h)  — very aggressive; memories older than a few hours matter little.
   *   86_400_000       (1 d)  — good for short-session assistants.
   *   7 * 86_400_000   (1 w)  — moderate; balances recency and long-term relevance.
   *   30 * 86_400_000  (1 mo) — gentle nudge toward freshness.
   */
  halfLifeMs: number;
  /**
   * Recency contribution weight in [0, 1]. Default `0.3`.
   *   0   → recency has no effect (identical to omitting the option entirely).
   *   1   → ordering is determined solely by recency (similarity is ignored).
   *   0.3 → default; similarity still dominates but fresh memories get a boost.
   */
  weight?: number;
  /**
   * Kept for API compatibility. The restart caveat described here has been resolved:
   * `ingestedAt` timestamps and `metadata` are now persisted through the memory-index
   * store (sqlite/libsql `memory_meta` sidecar table, postgres `memories` columns).
   * After a process restart, `searchMemory` returns the persisted values so recency
   * decay survives restarts. The in-memory maps remain as a hot cache for the current
   * process to avoid an extra store read on every ingest → retrieve cycle.
   */
  _restartCaveat?: never; // documentation-only field; never set
}

/**
 * Temporal markers that indicate a fact is transient (short-lived).
 *
 * When Consolidator or passiveExtract finds any of these tokens in the fact's supporting
 * text, `transientTtlMs` (if set) is applied so the fact expires automatically.
 *
 * Exported so callers can audit or extend the list.
 *
 * KEEP THIS LIST SHORT AND HIGH-PRECISION — false positives cause permanent facts to expire.
 */
export const TRANSIENT_MARKERS: readonly string[] = [
  "today",
  "currently",
  "right now",
  "this week",
  "this month",
  "at the moment",
  "şu an",       // Turkish: "right now"
  "bu hafta",    // Turkish: "this week"
  "şu anda",     // Turkish: "at the moment / currently"
];

export interface MemoryOptions {
  store: StorePort;
  vector?: VectorPort;
  embedder?: EmbeddingPort;
  reranker?: RerankPort;
  /**
   * Default number of snippets returned by `retrieve`. Overridden per-call via `query.topK`.
   * Default: `8`.
   */
  topK?: number;
  /**
   * Minimum similarity score a snippet must have to be included in `retrieve` results.
   * Snippets with a score below this threshold are filtered out AFTER RRF fusion and optional
   * reranking, just before the result is returned.
   *
   * Default: `undefined` (no threshold — all fused snippets are returned up to `topK`).
   * A value of `0.0` is equivalent to no threshold.
   *
   * Tip: start with a low value (e.g. `0.01`) and tune up if irrelevant snippets appear.
   */
  minScore?: number;
  blocks?: Record<string, string | BlockSpec>;
  newId?: () => string;
  graph?: GraphPort;
  /**
   * Controls passive fact extraction on ingest (§6.8). Requires `graph` to be configured.
   *   - "agentic"  (default) — no passive extraction; only the explicit Consolidator runs.
   *   - "passive"  — rule-based extraction on every ingest event; facts asserted with confidence 0.6.
   *   - "hybrid"   — passive extraction PLUS the agentic Consolidator (both run independently).
   */
  extraction?: "agentic" | "passive" | "hybrid";
  /**
   * Block labels that must be non-empty for the agent to function correctly (§6.5 hygiene nudge).
   * Used by `blockHealth()` to flag empty required blocks, including synthetic entries for blocks
   * that are configured here but not yet present in the store.
   */
  requiredBlocks?: string[];
  /**
   * Optional recency-weighted ranking (OFF by default).
   *
   * When set, `retrieve()` re-ranks the fused result set by blending similarity with an
   * exponential age-decay term. See `RecencyOptions` for the scoring formula and tuning notes.
   *
   * The `now` clock below is shared by this feature.
   */
  recency?: RecencyOptions;
  /**
   * Injectable wall-clock (returns ISO string). Used by recency-decay ranking to compute
   * `ageMs = Date.parse(now()) - ingestedAt`. Defaults to `() => new Date().toISOString()`.
   * Pass a controlled clock in tests to produce deterministic age calculations.
   */
  now?: () => string;
  /**
   * Maximum number of entries kept in the in-memory `metadataStore` and `ingestedAtStore` maps
   * (combined, each map is capped independently to this value). When the cap is exceeded, the
   * oldest-inserted entries are evicted first (insertion-order LRU via Map iteration order).
   *
   * Default: `undefined` (unbounded). For long-lived processes ingesting many events (e.g.
   * one event per agent turn, running for days), set this to a reasonable ceiling such as
   * `50_000` to prevent unbounded memory growth.
   *
   * Eviction does NOT break recency correctness: an evicted id simply falls back to
   * similarity-only ranking for that snippet — the same behaviour as after a process restart.
   *
   * `scopedIds` is bounded indirectly: when an id is evicted from `metadataStore` /
   * `ingestedAtStore`, it is also removed from the corresponding `scopedIds` set so that
   * `eraseScope` does not attempt to delete already-evicted entries.
   */
  maxInMemoryEntries?: number;
  /**
   * Deduplication on write (default: `true`).
   *
   * When `true`, `ingest` skips writing any event whose normalised text (trimmed, lowercased,
   * whitespace-collapsed) is identical to an event already ingested under the same scope in
   * the current process lifetime. This prevents the most common source of duplicates: re-ingesting
   * the same turn on retry or resume.
   *
   * **Semantics**: exact normalised-text match within the same scope. Near-duplicates (different
   * wording, same meaning) are NOT caught here — use `deduplicateArchival` for those.
   *
   * **NEW DEFAULT ON**: set `dedupeOnWrite: false` to restore the original append-always behaviour.
   */
  dedupeOnWrite?: boolean;
  /**
   * TTL applied to facts whose supporting text contains a transient temporal marker
   * (see exported `TRANSIENT_MARKERS` list). Facts with these markers are expected to
   * become stale quickly; assigning a short TTL causes them to be swept automatically
   * by `sweepExpiredFacts`.
   *
   * **Default: 86_400_000 (24 hours)** — enabled by default.
   * Set to `0` or `undefined` to disable transient TTLs entirely.
   *
   * Applies in the `passiveExtract` path (Memory.ingest with extraction: "passive"/"hybrid")
   * and is exported so the `Consolidator` can also apply it when asserting graph facts.
   *
   * IMPORTANT: this is a new-but-sensible default. Existing deployments that want to
   * preserve transient facts indefinitely should set `transientTtlMs: 0`.
   */
  transientTtlMs?: number;
  /**
   * Corroboration staleness window (the "confidently-wrong high-traffic fact" problem). When set,
   * `retrieve()` flags any knowledge-graph fact whose `lastCorroboratedAt` is older than this many
   * milliseconds as `stale: true`, and annotates the injected snippet text
   * ("(last confirmed >Nd ago — may be outdated)"). Stale facts are NEVER dropped — only flagged.
   *
   * Provide a single number for a global window, or a `Record<predicate, ms>` for per-predicate
   * windows (e.g. `{ works_at: 90 * 86_400_000, lives_in: 180 * 86_400_000 }`). A `__default` key
   * in the record applies to predicates not otherwise listed. Predicates with no matching entry and
   * no `__default` are never flagged stale.
   *
   * **Default: undefined (OFF)** — fully back-compatible; staleness flagging only happens when set.
   */
  corroborationTtlMs?: number | Record<string, number>;
  /**
   * Consent / privacy manifest (§15). When set, `ingest`-driven passive fact extraction and the
   * `assertFact` path classify content into categories and enforce per-category retention:
   *   - "never"   → the fact is rejected (not written); the rejection is surfaced/auditable.
   *   - "session" → a short session-scoped TTL is applied (manifest.sessionTtlMs, default 30 min).
   *   - number    → that retention (ms) is applied as the fact TTL.
   * Categories not listed in the manifest are unrestricted. Use `Memory.applyConsent` to enforce a
   * (possibly updated) manifest RETROACTIVELY over already-stored data.
   *
   * **Default: undefined (OFF)** — back-compatible; no classification or enforcement happens.
   */
  consent?: ConsentManifest;
}

const LN2 = Math.LN2; // ln(2) ≈ 0.693147

/** Default TTL (ms) applied to "session"-policy consent content: 30 minutes. */
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;

/**
 * Resolve the consent policy for a piece of text (optionally a structured fact) against a manifest.
 * Returns the matched category and its policy, or undefined when the content is unclassified or the
 * category is unrestricted (not present in the manifest). Uses the manifest's `classify` callback,
 * falling back to the built-in `defaultConsentClassifier`.
 */
function resolveConsent(
  manifest: ConsentManifest,
  text: string,
  fact?: Fact,
): { category: string; policy: ConsentPolicy } | undefined {
  const classify = manifest.classify ?? defaultConsentClassifier;
  const category = classify(text, fact);
  if (category === undefined) return undefined;
  const policy = manifest.categories[category];
  if (policy === undefined) return undefined; // category not governed → unrestricted
  return { category, policy };
}

/**
 * Translate a non-"never" consent policy into a TTL (ms) to apply as a fact/memory expiry.
 * "session" → manifest.sessionTtlMs (default 30 min); number → that retention; "never" → 0 (caller
 * must reject before reaching here).
 */
function consentTtlMs(manifest: ConsentManifest, policy: ConsentPolicy): number {
  if (policy === "never") return 0;
  if (policy === "session") return manifest.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  return policy;
}

/** Resolve the corroboration window (ms) for a predicate from a number | per-predicate record. */
function corroborationWindowFor(
  cfg: number | Record<string, number>,
  predicate: string,
): number | undefined {
  if (typeof cfg === "number") return cfg;
  if (predicate in cfg) return cfg[predicate];
  if ("__default" in cfg) return cfg["__default"];
  return undefined;
}

/** Humanize a millisecond age into a coarse "Nd"/"Nh" string for stale annotations. */
function humanizeAge(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m`;
}

/**
 * Re-rank a list of snippets by blending their similarity scores with an exponential recency
 * decay term. Pure function — does not mutate the input array.
 *
 * score = (1 - weight) * normalizedSimilarity + weight * exp(-ln(2) * ageMs / halfLifeMs)
 *
 * Similarity scores are linearly normalized to [0, 1] across the candidate set so the formula
 * is scale-invariant regardless of the retrieval back-end (BM25, cosine, RRF fused, etc.).
 * When all snippets have the same score (including when the list has a single element) the
 * normalization denominator is 0 and every snippet gets normalizedSimilarity = 1.
 *
 * @param snippets    - Candidate snippets in their current order.
 * @param opts        - Recency config (halfLifeMs, weight).
 * @param ingestedAt  - Map<id, epoch-ms> recording when each snippet was ingested.
 * @param nowMs       - Current epoch-ms (injectable for testability).
 * @returns Re-scored and re-sorted snippets with the combined score stored in `.score`.
 */
function applyRecencyDecay(
  snippets: MemorySnippet[],
  opts: RecencyOptions,
  ingestedAt: ReadonlyMap<string, number>,
  nowMs: number,
): MemorySnippet[] {
  if (snippets.length === 0) return snippets;
  const weight = opts.weight ?? 0.3;
  const { halfLifeMs } = opts;

  // FIX 4: Guard against NaN — if the injectable clock returned a non-ISO string,
  // Date.parse yields NaN which would propagate into every combined score and destroy ordering.
  // When nowMs is NaN, fall back to similarity-only for all snippets (recencyFactor = 1).
  const nowValid = !Number.isNaN(nowMs);

  // Normalize similarity scores to [0, 1].
  const scores = snippets.map((s) => s.score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const range = maxScore - minScore;

  return snippets
    .map((s) => {
      const normSim = range === 0 ? 1 : (s.score - minScore) / range;
      const ingestedMs = ingestedAt.get(s.id);
      // NaN guard: if nowMs or the stored ingestedMs is NaN, skip recency for this snippet.
      // Falls back to recencyFactor = 1 (maximally fresh) — same as an unknown-age snippet.
      const ingestedValid = ingestedMs !== undefined && !Number.isNaN(ingestedMs);
      const canApplyRecency = nowValid && ingestedValid;
      // Snippets not in the ingestedAt map (e.g. fact: prefixed entity-signal entries) get
      // a recency factor of 1 (treated as maximally fresh) so they are never penalised.
      const ageMs = canApplyRecency ? Math.max(0, nowMs - ingestedMs!) : 0;
      const recencyFactor = canApplyRecency ? Math.exp(-LN2 * ageMs / halfLifeMs) : 1;
      const combined = (1 - weight) * normSim + weight * recencyFactor;
      return { ...s, score: combined };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Thrown by `Memory.assertFact` when a fact is rejected by a consent manifest whose category policy
 * is "never". Callers that assert facts under a manifest should catch this to surface/audit rejections.
 * The passive-extraction path inside `ingest` catches it internally and counts it (never throws to the
 * caller), keeping ingest robust.
 */
export class ConsentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentRejectedError";
  }
}

/**
 * Explicitly move vectors written with the pre-v2 delimiter key to an operator-selected scope.
 * Normal recall never invokes this helper. The target must be empty, and `list` is required so
 * migration cannot guess, merge tenants, or silently lose vector payloads.
 */
export async function migrateLegacyScopeVectors(vector: VectorPort, scope: Scope): Promise<{ migrated: number }> {
  const from = legacyScopeKey(scope);
  const to = scopeKey(scope);
  if (from === to) return { migrated: 0 };
  if (!vector.list) throw new Error("legacy vector scope migration requires VectorPort.list");
  const source = await vector.list(from);
  if (source.length === 0) return { migrated: 0 };
  const target = await vector.list(to);
  const sourceById = new Map(source.map((entry) => [entry.id, entry]));
  const samePayload = (a: VectorEntry, b: VectorEntry) =>
    a.text === b.text && a.vector.length === b.vector.length && a.vector.every((value, index) => value === b.vector[index]);
  for (const entry of target) {
    const expected = sourceById.get(entry.id);
    if (!expected || !samePayload(entry, expected)) {
      throw new Error(`legacy vector scope migration target contains unrelated data: ${to}`);
    }
  }
  const targetIds = new Set(target.map((entry) => entry.id));
  for (const entry of source) if (!targetIds.has(entry.id)) await vector.upsert({ ...entry, scopeKey: to });
  const verified = await vector.list(to);
  if (verified.length !== source.length || verified.some((entry) => {
    const expected = sourceById.get(entry.id);
    return !expected || !samePayload(entry, expected);
  })) throw new Error("legacy vector scope migration copy verification failed; source was retained");
  const erased = await vector.eraseScope(from);
  if (erased.deleted !== source.length) {
    throw new Error(`legacy vector scope migration source count changed (expected ${source.length}, erased ${erased.deleted})`);
  }
  return { migrated: source.length };
}

/** Health snapshot for one always-in-context block (§6.5). */
export interface BlockHealth {
  label: string;
  length: number;
  limit?: number;
  /** length / limit when limit is defined; undefined otherwise. */
  fillRatio?: number;
  isEmpty: boolean;
  /** True when the label appears in `MemoryOptions.requiredBlocks`. */
  required: boolean;
}

/**
 * Unified memory: Tier-1 self-editing blocks + recall. Recall is lexical-only (zero-infra)
 * unless you provide `vector` + `embedder`, which adds the semantic signal (RRF-fused) and,
 * with an optional `reranker`, cross-encoder rerank. "lite" vs "full" is just whether you wire
 * a vector store — one class, graceful degradation.
 */
export class Memory implements EditableMemoryPort {
  private readonly editor: BlockEditor;
  private readonly semantic: boolean;
  /** True when a graph backend was provided at construction time. */
  readonly graphEnabled: boolean;
  /**
   * In-process hot cache for event metadata, keyed by an injective `[scopeKey,eventId]` tuple.
   * `event.metadata` is present. Used by `retrieve` as a fallback when the store does not yet
   * return a persisted value (e.g. same-process ingest without a round-trip). The authoritative
   * values are now persisted through `indexMemory` and returned by `searchMemory`.
   */
  private readonly metadataStore = new Map<string, { source?: string; page?: number; [k: string]: unknown }>();
  /**
   * In-process hot cache for ingest timestamps, keyed by an injective `[scopeKey,eventId]` tuple.
   * `ingest` call. Used by recency-decay ranking in `retrieve` as a fallback when the store does
   * not yet return a persisted value. The authoritative values are now persisted through
   * `indexMemory` and returned by `searchMemory`.
   */
  private readonly ingestedAtStore = new Map<string, number>();
  /**
   * Scope-to-ids index: tracks which event ids were ingested under each scope key.
   * Used by `eraseScope` to precisely purge only the ids belonging to the erased scope
   * from `metadataStore` and `ingestedAtStore`, without touching other scopes' entries.
   */
  private readonly scopedIds = new Map<string, Set<string>>();
  /**
   * Dedup-on-write index: tracks `scopeKey + "\0" + normalizedText` for every event
   * successfully written. Used by `ingest` to skip exact-duplicate writes when
   * `dedupeOnWrite` is true (the default).
   */
  private readonly seenNormTexts = new Set<string>();
  /**
   * Raw ingested text cache: `[scope,id]` → text, populated during `ingest`.
   * stored entries and `exportScope`/`mergeScopes` recover entry text without a store scan (the
   * lexical FTS index has no "list all entries for scope" primitive). In-process only — cleared on
   * restart / eviction; facts (passive extraction) are the durable, restart-safe consent carrier.
   */
  private readonly textStore = new Map<string, string>();
  /** Resolved wall-clock function (injectable for tests). */
  private readonly clock: () => string;

  constructor(private readonly opts: MemoryOptions) {
    if (!!opts.vector !== !!opts.embedder) {
      throw new Error("Memory: `vector` and `embedder` must be provided together (semantic recall needs both).");
    }
    if (opts.reranker && !opts.vector) {
      throw new Error("Memory: `reranker` requires `vector` + `embedder`.");
    }
    this.semantic = !!opts.vector && !!opts.embedder;
    this.graphEnabled = !!opts.graph;
    this.clock = opts.now ?? (() => new Date().toISOString());
    this.editor = new BlockEditor({
      store: opts.store,
      blocks: opts.blocks,
      ingest: (events) => this.ingest(events),
      newId: opts.newId,
    });
  }

  getAlwaysInContext(scope: Scope): Promise<MemoryBlock[]> { return this.editor.getAlwaysInContext(scope); }
  append(scope: Scope, label: string, text: string): Promise<BlockEdit> { return this.editor.append(scope, label, text); }
  replace(scope: Scope, label: string, find: string, replace: string, version: number): Promise<BlockEdit> { return this.editor.replace(scope, label, find, replace, version); }
  rewrite(scope: Scope, label: string, value: string, version: number): Promise<BlockEdit> { return this.editor.rewrite(scope, label, value, version); }
  archive(scope: Scope, text: string): Promise<void> { return this.editor.archive(scope, text); }

  /**
   * Block health snapshot (§6.5). Reports fill ratio, emptiness, and required status for every
   * always-in-context block. Also includes a synthetic entry for any `requiredBlocks` label that
   * is configured but not yet present in the store (length: 0, isEmpty: true, required: true).
   *
   * FIX 6 — HIDDEN WRITE SIDE-EFFECT (documented):
   * This method internally calls `getAlwaysInContext`, which seeds any configured-but-absent
   * blocks as a WRITE to the underlying store. Despite its read-like name, `blockHealth` is
   * therefore NOT a pure query — it may create block rows if they do not already exist.
   * Callers that need a strict read-only snapshot should call `store.getBlock` directly and
   * build their own health summary without the seeding behaviour.
   *
   * The return value's `isEmpty: true, required: true` entries for missing blocks reflect
   * this seeding: those blocks are created (empty) on first call, so subsequent calls see them
   * as real blocks (not synthetic entries) with `length: 0`.
   */
  async blockHealth(scope: Scope): Promise<BlockHealth[]> {
    const blocks = await this.getAlwaysInContext(scope);
    const required = new Set(this.opts.requiredBlocks ?? []);
    const seen = new Set<string>();
    const result: BlockHealth[] = [];

    for (const b of blocks) {
      seen.add(b.label);
      const length = b.value.length;
      const fillRatio = b.limit !== undefined ? length / b.limit : undefined;
      result.push({
        label: b.label,
        length,
        limit: b.limit,
        fillRatio,
        isEmpty: length === 0,
        required: required.has(b.label),
      });
    }

    // Synthetic entries for requiredBlocks that are not yet in the store
    for (const label of required) {
      if (!seen.has(label)) {
        result.push({ label, length: 0, isEmpty: true, required: true });
      }
    }

    return result;
  }

  /**
   * GDPR right-to-erasure (§15): hard-delete ALL data for `scope` across the store (lexical index,
   * blocks, block_history, facts, sessions, events) and — when semantic is configured — the vector
   * store, and — when a separately-injected GraphPort with an `eraseScope` method is configured —
   * the graph facts store. Returns the counts from each subsystem. Irreversible. Scope-isolated.
   *
   * FIX 1 — BEST-EFFORT / PARTIAL-FAILURE semantics:
   * Each subsystem (store, vector, graph) is attempted independently; a failure in one does NOT
   * prevent the others from running. In-memory maps are ALWAYS cleared for the erased scope
   * (in a `finally` block) regardless of subsystem errors, so they never leak after partial failure.
   * If any subsystem threw, an aggregate Error is thrown after all three have been attempted,
   * listing which subsystems failed. Callers should inspect the error message to determine which
   * parts of the erase succeeded.
   *
   * FIX 2 — vector method name: calls `vector.eraseScope` (renamed from `deleteScope` in the
   * coordinated types update; same behaviour and return shape `{ deleted: number }`).
   *
   * NOTE on shared-scope stores: when `graph` is the same object as `store` (or shares underlying
   * storage), `StorePort.eraseScope` already covers facts. The `graph.eraseScope` call below is
   * only relevant when `graph` points to a DISTINCT adapter with its own separate persistence.
   * If `graph.eraseScope` is absent (older adapters that pre-date this method), the graph facts
   * are skipped — backward-compatible, but facts in that graph store will not be fully erased.
   */
  async eraseScope(scope: Scope): Promise<{ store: number; vector: number; graph: number }> {
    const sk = scopeKey(scope);
    const failures: string[] = [];
    let storeCount = 0;
    let vectorCount = 0;
    let graphCount = 0;

    // 1. Store subsystem
    try {
      const { deleted } = await this.opts.store.eraseScope(scope);
      storeCount = deleted;
    } catch (err) {
      failures.push(`store: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Vector subsystem
    if (this.semantic && this.opts.vector) {
      try {
        const { deleted } = await this.opts.vector.eraseScope(sk);
        vectorCount = deleted;
      } catch (err) {
        failures.push(`vector: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Graph subsystem
    // A4: erase graph facts when a separately-injected GraphPort provides eraseScope.
    // When graph and store share storage, StorePort.eraseScope already covers facts;
    // calling eraseScope on both is harmless (the second call will see 0 remaining rows).
    if (this.opts.graph && typeof this.opts.graph.eraseScope === "function") {
      try {
        const { deleted } = await this.opts.graph.eraseScope(scope);
        graphCount = deleted;
      } catch (err) {
        failures.push(`graph: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. ALWAYS clear in-memory maps for this scope (FIX 1: finally-style guarantee).
    // We use the scopedIds index (populated during ingest) to know exactly which event ids
    // belong to this scope so we don't disturb entries for other scopes (cross-scope isolation).
    const ids = this.scopedIds.get(sk);
    if (ids) {
      for (const id of ids) {
        const key = memoryCacheKey(sk, id);
        this.metadataStore.delete(key);
        this.ingestedAtStore.delete(key);
        this.textStore.delete(key);
      }
      this.scopedIds.delete(sk);
    }
    // Clear dedup-on-write entries for this scope so re-ingest after erase is allowed.
    const skPrefix = `${sk}\0`;
    for (const key of this.seenNormTexts) {
      if (key.startsWith(skPrefix)) this.seenNormTexts.delete(key);
    }

    // 5. Throw aggregate error if any subsystem failed (after all attempts + map cleanup).
    if (failures.length > 0) {
      throw new Error(`Memory.eraseScope partial failure — ${failures.join("; ")}`);
    }

    return { store: storeCount, vector: vectorCount, graph: graphCount };
  }

  /**
   * Evict the oldest `excess` entries from a Map (insertion-order LRU style).
   * Also removes the evicted ids from `scopedIds` to keep the scope index in sync.
   */
  private evictFromMap<V>(map: Map<string, V>, excess: number): void {
    if (excess <= 0) return;
    let evicted = 0;
    for (const key of map.keys()) {
      if (evicted >= excess) break;
      map.delete(key);
      // Keep the text cache bounded alongside the metadata/ingestedAt maps.
      this.textStore.delete(key);
      const owner = memoryCacheOwner(key);
      if (owner) {
        const ids = this.scopedIds.get(owner.scopeKey);
        ids?.delete(owner.id);
        if (ids?.size === 0) this.scopedIds.delete(owner.scopeKey);
      }
      evicted++;
    }
  }

  async assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    if (!this.opts.graph) throw new Error("Memory: no graph configured (pass `graph` to enable the temporal knowledge graph).");
    const effective = this.applyConsentToAssertInput(input);
    if (effective === null) {
      throw new ConsentRejectedError(`fact rejected by consent manifest (subject='${input.subject}', predicate='${input.predicate}')`);
    }
    return this.opts.graph.assertFact(scope, effective);
  }

  /**
   * Apply the consent manifest (if any) to an assertFact input at write time.
   * Returns `null` when the content's category policy is "never" (caller must reject),
   * or an input augmented with a consent TTL when the policy is "session"/number.
   * Returns the input unchanged when no manifest is set or the content is unrestricted.
   *
   * The classifier inspects a synthetic fact built from the input so predicate/object-based rules fire.
   */
  private applyConsentToAssertInput(input: AssertFactInput): AssertFactInput | null {
    const manifest = this.opts.consent;
    if (!manifest) return input;
    const probe: Fact = {
      id: "", subject: input.subject, predicate: input.predicate, object: input.object,
      objectKind: input.objectKind ?? "literal", validFrom: input.validFrom ?? this.clock(), confidence: input.confidence ?? 1,
    };
    const text = `${input.subject} ${input.predicate} ${input.object}`;
    const matched = resolveConsent(manifest, text, probe);
    if (!matched) return input;
    if (matched.policy === "never") return null;
    const ttlMs = consentTtlMs(manifest, matched.policy);
    // Honour an existing shorter TTL; otherwise apply the consent TTL.
    const existingTtl = input.ttlMs;
    const effectiveTtl = existingTtl !== undefined ? Math.min(existingTtl, ttlMs) : ttlMs;
    return { ...input, ttlMs: effectiveTtl };
  }
  async queryFacts(query: FactQuery): Promise<Fact[]> {
    if (!this.opts.graph) throw new Error("Memory: no graph configured (pass `graph` to enable the temporal knowledge graph).");
    return this.opts.graph.queryFacts(query);
  }

  /**
   * Staleness sweep (§6.5 duty 3): invalidate every currently-valid fact whose TTL has elapsed
   * (expiresAt <= now). Delegates to the graph; returns the count invalidated. `now` is injectable
   * for deterministic tests (defaults to wall-clock ISO).
   */
  async sweepExpiredFacts(scope: Scope, now?: string): Promise<number> {
    if (!this.opts.graph) throw new Error("Memory: no graph configured (pass `graph` to enable the temporal knowledge graph).");
    return this.opts.graph.sweepExpired(scope, now ?? new Date().toISOString());
  }

  /**
   * State-transition timeline (evolution, not replacement): the full version history for one
   * (scope, subject, predicate) — every version ever asserted, valid or invalidated, ordered
   * ascending by validFrom. Each fact's `supersedes` links it to the prior version it replaced.
   * Example: "lived in NY, then moved to SF" returns both facts (NY invalidated, SF current).
   */
  async factTimeline(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    if (!this.opts.graph) throw new Error("Memory: no graph configured (pass `graph` to enable the temporal knowledge graph).");
    return this.opts.graph.factHistory(scope, subject, predicate);
  }

  /**
   * Corroboration (staleness tiers): re-confirm a still-valid fact, bumping its `lastCorroboratedAt`.
   * Cheap UPDATE — no new row, no invalidation. Returns 1 if a valid fact was bumped, 0 otherwise.
   * `at` defaults to now (epoch-ms). See `MemoryOptions.corroborationTtlMs` for how the freshness
   * window is consumed at retrieval time.
   */
  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    if (!this.opts.graph) throw new Error("Memory: no graph configured (pass `graph` to enable the temporal knowledge graph).");
    return this.opts.graph.corroborate(scope, factId, at);
  }

  /**
   * Retroactively enforce a consent manifest over already-stored data (§15). Sweeps existing facts
   * and memory entries that NOW classify into a forbidden category:
   *   - "never"   → facts invalidated (validUntil set; temporal audit preserved), memory entries erased.
   *   - "session" / number → facts whose age already exceeds the retention window are invalidated;
   *     fresher ones are left (their write-time TTL governs future expiry). Memory entries past the
   *     retention window are erased.
   *
   * Category is re-derived at sweep time via the manifest's classifier (deterministic), so no extra
   * per-row category column is needed. Returns an audit count — erasures are never silent.
   *
   * Lexical rows are enumerated and deleted through the durable StorePort, so this remains complete
   * after restart. Hot caches and the optional vector index are purged only after durable deletion.
   */
  async applyConsent(scope: Scope, manifest: ConsentManifest): Promise<ConsentResult> {
    const result: ConsentResult = { rejected: 0, sweptFacts: 0, sweptMemories: 0 };
    const nowIso = this.clock();
    const nowMs = Date.parse(nowIso);

    // 1. Facts — re-classify each currently-valid fact and invalidate forbidden ones by expiry.
    // Invalidation (validUntil set, NOT deleted) preserves the temporal audit trail (§6.6) while
    // removing the fact from currently-valid queries. We collect the forbidden ids and invalidate
    // them in one pass via the graph's `expireFacts` primitive.
    if (this.opts.graph) {
      const facts = await this.opts.graph.queryFacts({ scope });
      const toExpire: string[] = [];
      for (const f of facts) {
        const text = `${f.subject} ${f.predicate} ${f.object}`;
        const matched = resolveConsent(manifest, text, f);
        if (!matched) continue;
        if (matched.policy === "never") {
          toExpire.push(f.id);
          result.rejected += 1;
        } else {
          // session/number retention: invalidate facts already older than the retention window.
          const ttl = consentTtlMs(manifest, matched.policy);
          const lastCorr = f.lastCorroboratedAt ?? Date.parse(f.validFrom);
          if (!Number.isNaN(lastCorr) && !Number.isNaN(nowMs) && nowMs - lastCorr > ttl) {
            toExpire.push(f.id);
          }
        }
      }
      if (toExpire.length > 0 && typeof this.opts.graph.expireFacts === "function") {
        const n = await this.opts.graph.expireFacts(scope, toExpire, nowIso);
        result.sweptFacts += n;
      }
    }

    // 2. Memory entries — enumerate the durable lexical store, then erase exact forbidden ids.
    const sk = scopeKey(scope);
    const durableEntries = await this.opts.store.listMemory(scope);
    const toDelete: string[] = [];
    const neverIds = new Set<string>();
    for (const entry of durableEntries) {
      const matched = resolveConsent(manifest, entry.text);
      if (!matched) continue;
      let erase = matched.policy === "never";
      if (!erase && matched.policy !== "never") {
        const ttl = consentTtlMs(manifest, matched.policy);
        if (entry.ingestedAt !== undefined && !Number.isNaN(nowMs) && nowMs - entry.ingestedAt > ttl) erase = true;
      }
      if (!erase) continue;
      toDelete.push(entry.id);
      if (matched.policy === "never") neverIds.add(entry.id);
    }
    if (toDelete.length > 0) {
      const deleted = await this.opts.store.deleteMemory(scope, toDelete);
      if (deleted !== toDelete.length) {
        throw new Error(`Memory consent sweep deleted ${deleted}/${toDelete.length} durable entries`);
      }
      const hotIds = this.scopedIds.get(sk);
      for (const id of toDelete) {
        const cacheKey = memoryCacheKey(sk, id);
        this.metadataStore.delete(cacheKey);
        this.ingestedAtStore.delete(cacheKey);
        this.textStore.delete(cacheKey);
        hotIds?.delete(id);
        if (this.semantic && this.opts.vector) {
          try { await this.opts.vector.delete(id, sk); } catch { /* best-effort */ }
        }
      }
      if (hotIds?.size === 0) this.scopedIds.delete(sk);
      result.sweptMemories = deleted;
      result.rejected += neverIds.size;
    }

    return result;
  }

  /**
   * GDPR-portable export (§15 data-subject-access / portability). A versioned, structured snapshot of
   * everything stored for `scope`: lexical memory entries (with ingestedAt + provenance metadata),
   * the FULL temporal knowledge graph (all fact versions incl. supersedes + lastCorroboratedAt),
   * always-in-context blocks, and per-block version history.
   *
   * Memory entries are enumerated from the durable store, so exports are complete across process
   * restarts and independent of the bounded hot caches.
   *
   * Event-sourced session history is intentionally NOT included — sessions are conversation transcripts,
   * not memory; export them separately via `StorePort.readEvents` if needed.
   */
  async exportScope(scope: Scope): Promise<MemoryExport> {
    // Facts: full timeline (valid + invalidated) for the scope.
    const facts: Fact[] = this.opts.graph
      ? await this.opts.graph.queryFacts({ scope, includeInvalidated: true })
      : [];

    // Blocks + per-block history.
    const blocks = await this.opts.store.listBlocks(scope);
    const blockHistory: Record<string, import("@eidentic/types").BlockHistoryEntry[]> = {};
    for (const b of blocks) {
      blockHistory[b.label] = await this.opts.store.getBlockHistory(scope, b.label);
    }

    const memories: MemoryExport["memories"] = await this.opts.store.listMemory(scope);

    return {
      schema: "eidentic.memory.export.v1",
      exportedAt: this.clock(),
      scope,
      memories,
      facts,
      blocks,
      blockHistory,
    };
  }

  /**
   * Identity merge (§15): upgrade an anonymous scope to an authenticated one. Copies all memory data
   * from `from` into `to`, then erases `from`. Crash-safe ordering: COPY happens first and is verified
   * by count BEFORE the source erase; a failure mid-merge leaves the source intact (no data loss),
   * at worst producing duplicate-in-target which is idempotent on re-run.
   *
   * What moves:
   *   - Memory entries: re-indexed under `to` (new scope_key) with provenance metadata
   *     `{ mergedFrom, mergedAt }` merged into each entry's metadata.
   *   - Facts: re-asserted under `to` preserving temporal fields (validFrom/validUntil/expiresAt/
   *     supersedes/lastCorroboratedAt). Contradictions resolve via normal invalidation respecting
   *     validFrom ordering.
   *   - Blocks (CONSERVATIVE): only blocks whose label is ABSENT in the target are copied; existing
   *     target blocks are left untouched (we never clobber the authenticated user's own blocks).
   *
   * What does NOT move: event-sourced session history (transcripts are not memory — they stay put).
   *
   * @param opts.conflict — "keep-both" (default): re-assert facts so target contradictions invalidate
   *   per validFrom order (both versions visible in the timeline). "prefer-target": skip any source
   *   fact whose (subject, predicate) already has a currently-valid fact in the target.
   */
  async mergeScopes(
    from: Scope,
    to: Scope,
    opts?: { conflict?: "keep-both" | "prefer-target" },
  ): Promise<{ memories: number; facts: number; blocks: number }> {
    const conflict = opts?.conflict ?? "keep-both";
    const mergedAt = this.clock();
    const fromKey = scopeKey(from);
    const counts = { memories: 0, facts: 0, blocks: 0 };

    // ---- COPY PHASE (must complete + be verified before any erase) ----

    // 1. Memories — re-index under `to` with provenance. Text comes from the export composition.
    const snapshot = await this.exportScope(from);
    const memEntries = snapshot.memories.map((m) => ({
        scope: to,
        id: m.id,
        text: m.text,
        ...(m.ingestedAt !== undefined ? { ingestedAt: m.ingestedAt } : {}),
        metadata: { ...(m.metadata ?? {}), mergedFrom: fromKey, mergedAt },
      }));
    if (memEntries.length > 0) {
      await this.opts.store.indexMemory(memEntries);
      // Mirror caches + vector store under the target scope.
      const toKey = scopeKey(to);
      let toIds = this.scopedIds.get(toKey);
      if (!toIds) { toIds = new Set<string>(); this.scopedIds.set(toKey, toIds); }
      for (const m of memEntries) {
        toIds.add(m.id);
        const cacheKey = memoryCacheKey(toKey, m.id);
        if (m.ingestedAt !== undefined) this.ingestedAtStore.set(cacheKey, m.ingestedAt);
        this.metadataStore.set(cacheKey, m.metadata);
        this.textStore.set(cacheKey, m.text);
        if (this.semantic && this.opts.embedder && this.opts.vector) {
          const vec = await this.opts.embedder.embed(m.text);
          await this.opts.vector.upsert({ id: m.id, scopeKey: toKey, text: m.text, vector: vec });
        }
      }
      counts.memories = memEntries.length;
    }

    // 2. Facts — re-assert under `to` preserving temporal fields, oldest-first (validFrom order)
    //    so contradiction-invalidation reproduces the original timeline.
    if (this.opts.graph) {
      const ordered = [...snapshot.facts].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
      for (const f of ordered) {
        if (conflict === "prefer-target") {
          // Skip if the target already has ANY currently-valid fact for this (subject, predicate).
          const existing = await this.opts.graph.queryFacts({ scope: to, subject: f.subject, predicate: f.predicate });
          if (existing.length > 0) continue;
        }
        try {
          await this.opts.graph.assertFact(to, {
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            objectKind: f.objectKind,
            validFrom: f.validFrom,
            confidence: f.confidence,
            ...(f.source !== undefined ? { source: f.source } : {}),
            ...(f.expiresAt !== undefined ? { expiresAt: f.expiresAt } : {}),
            ...(f.lastCorroboratedAt !== undefined ? { lastCorroboratedAt: f.lastCorroboratedAt } : {}),
          });
          counts.facts += 1;
        } catch {
          // temporal-order conflict / duplicate — skip; merge stays best-effort + non-destructive.
        }
      }
    }

    // 3. Blocks — conservative: copy only labels ABSENT in target (never clobber target's own blocks).
    const targetBlocks = new Set((await this.opts.store.listBlocks(to)).map((b) => b.label));
    for (const b of snapshot.blocks) {
      if (targetBlocks.has(b.label)) continue;
      await this.opts.store.upsertBlock(to, { label: b.label, value: b.value });
      counts.blocks += 1;
    }

    // ---- VERIFY + ERASE PHASE ----
    // Crash-safety: only erase the source AFTER the copy above resolved. If anything above threw,
    // we never reach here and the source is untouched (caller can safely re-run — re-indexing is
    // idempotent by id and fact re-assert is idempotent on the same object).
    //
    // Hot caches are keyed by the full `[scope,id]` tuple, so erasing the source cannot purge the
    // newly copied target entries even when ids are intentionally reused.
    await this.eraseScope(from);

    return counts;
  }

  /**
   * Normalise a text string for deduplication comparison:
   * trim, lowercase, and collapse all whitespace runs to a single space.
   */
  private static normalizeText(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  async ingest(events: MemoryEvent[]): Promise<void> {
    // dedupeOnWrite: default ON — skip events whose normalised text already exists in the same scope.
    const dedupeOnWrite = this.opts.dedupeOnWrite !== false;
    let filtered = events;
    if (dedupeOnWrite) {
      filtered = events.filter((e) => {
        const sk = scopeKey(e.scope);
        const norm = Memory.normalizeText(e.text);
        const seenKey = `${sk}\0${norm}`;
        if (this.seenNormTexts.has(seenKey)) return false;
        this.seenNormTexts.add(seenKey);
        return true;
      });
    } else {
      // Still track for future dedup checks (populate the set even when not filtering).
      for (const e of events) {
        const sk = scopeKey(e.scope);
        const norm = Memory.normalizeText(e.text);
        this.seenNormTexts.add(`${sk}\0${norm}`);
      }
    }

    // Consent enforcement at WRITE time (§15): drop raw memory entries whose text classifies into a
    // "never" category. Memory text has no per-row TTL column, so "session"/number retention for raw
    // text is enforced retroactively via `applyConsent` (re-classified at sweep time); only the hard
    // "never" rejection is applied here. Robust + silent (ingest is on the hot path); the auditable
    // erasure path is `applyConsent`.
    if (this.opts.consent) {
      const manifest = this.opts.consent;
      filtered = filtered.filter((e) => {
        const matched = resolveConsent(manifest, e.text);
        return !(matched && matched.policy === "never");
      });
    }

    if (filtered.length === 0) return;

    // Feature 3: persist metadata per event id so retrieve() can attach it to snippets.
    // Recency: record ingest timestamp (epoch ms) for each event using the injectable clock.
    const nowMs = Date.parse(this.clock());
    for (const e of filtered) {
      const sk = scopeKey(e.scope);
      const cacheKey = memoryCacheKey(sk, e.id);
      if (e.metadata !== undefined) {
        this.metadataStore.set(cacheKey, e.metadata);
      }
      this.ingestedAtStore.set(cacheKey, nowMs);
      // Track scope → id membership so eraseScope can precisely purge in-memory maps.
      let ids = this.scopedIds.get(sk);
      if (!ids) { ids = new Set<string>(); this.scopedIds.set(sk, ids); }
      ids.add(e.id);
      // Cache raw text so applyConsent can re-classify and exportScope/mergeScopes can recover text.
      this.textStore.set(cacheKey, e.text);
    }

    // FIX 3: enforce bounded map sizes to prevent unbounded memory growth in long-lived processes.
    // Evict oldest entries (Map insertion order) when either map exceeds maxInMemoryEntries.
    const cap = this.opts.maxInMemoryEntries;
    if (cap !== undefined) {
      if (this.metadataStore.size > cap) {
        this.evictFromMap(this.metadataStore, this.metadataStore.size - cap);
      }
      if (this.ingestedAtStore.size > cap) {
        this.evictFromMap(this.ingestedAtStore, this.ingestedAtStore.size - cap);
      }
    }
    await this.opts.store.indexMemory(filtered.map((e) => ({
      scope: e.scope,
      id: e.id,
      text: e.text,
      ingestedAt: nowMs,
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    })));
    if (this.semantic) {
      const embedder = this.opts.embedder!;
      if (embedder.embedBatch && filtered.length > 0) {
        // Batched path: embed all texts in ONE call, then upsert all vectors concurrently.
        const vectors = await embedder.embedBatch(filtered.map((e) => e.text));
        await Promise.all(
          filtered.map((e, i) =>
            this.opts.vector!.upsert({ id: e.id, scopeKey: scopeKey(e.scope), text: e.text, vector: vectors[i]! }),
          ),
        );
      } else {
        // Fallback: per-item serial embed + upsert (unchanged behaviour when embedBatch is absent).
        for (const e of filtered) {
          const vector = await embedder.embed(e.text);
          await this.opts.vector!.upsert({ id: e.id, scopeKey: scopeKey(e.scope), text: e.text, vector });
        }
      }
    }
    // Passive extraction (§6.8): rule-based facts asserted into the graph.
    // Only runs when `extraction` is "passive" or "hybrid" AND a graph is configured.
    // Each assertFact is wrapped in try/catch so a temporal-order rejection or bad triple
    // never breaks ingest — silently dropped (mirrors the Consolidator's robustness).
    const extraction = this.opts.extraction ?? "agentic";
    if ((extraction === "passive" || extraction === "hybrid") && this.opts.graph) {
      // Resolve effective transient TTL: default 24 h; 0 disables.
      const transientTtlMs = this.opts.transientTtlMs !== undefined ? this.opts.transientTtlMs : 86_400_000;
      for (const e of filtered) {
        const subject = subjectForEvent(e);
        const extracted = passiveExtract(e.text, subject);
        for (const fact of extracted) {
          try {
            // Apply transient TTL when the source text contains a temporal marker.
            const isTransient = transientTtlMs > 0 && hasTransientMarker(e.text);
            // Consent enforcement (§15): "never" → skip; "session"/number → apply consent TTL.
            const baseInput: AssertFactInput = {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              objectKind: "literal",
              confidence: 0.6,
              source: e.id,
              ...(isTransient ? { ttlMs: transientTtlMs } : {}),
            };
            const effective = this.applyConsentToAssertInput(baseInput);
            if (effective === null) continue; // consent "never" — drop silently (counted via applyConsent)
            await this.opts.graph.assertFact(e.scope, effective);
          } catch {
            // silently drop: temporal-order violation, bad triple, etc.
          }
        }
      }
    }
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievedMemory> {
    const k = query.topK ?? this.opts.topK ?? 20;
    const queryScopeKey = scopeKey(query.scope);
    // Fetch a wider candidate pool per signal before RRF fusion (Fix §6.4 recall quality):
    // an item ranked just outside k in one signal may be top in another — fetching k*3 before fusion
    // prevents it from being dropped before RRF can rescue it.
    const pool = Math.min(k * 3, 200);
    const lexical = await this.opts.store.searchMemory(query.scope, query.text, pool);
    const signals: MemorySnippet[][] = [lexical];
    if (this.semantic) {
      const qv = await this.opts.embedder!.embed(query.text);
      const semantic: VectorSearchResult[] = await this.opts.vector!.search(qv, scopeKey(query.scope), pool);
      signals.push(semantic);
    }
    if (this.opts.graph) {
      signals.push(await this.entitySignal(query, pool));
    }
    let fused: MemorySnippet[] = reciprocalRankFusion(signals).slice(0, k);
    if (this.opts.reranker) fused = await this.opts.reranker.rerank(query.text, fused);
    // Apply minScore threshold: filter out snippets below the configured minimum score.
    const minScore = this.opts.minScore;
    if (minScore !== undefined && minScore > 0) {
      fused = fused.filter((s) => s.score >= minScore);
    }
    // Attach metadata and ingestedAt to snippets. Prefer persisted store values (survive
    // restart); fall back to in-memory hot-cache for entries that haven't hit the store yet
    // (e.g. within the same ingest call before the write completes, or fact: prefixed entries).
    const withMeta: MemorySnippet[] = fused.slice(0, k).map((s) => {
      // Persisted values come through on the snippet itself (set by searchMemory).
      // In-memory cache fills in any gap (e.g. same-process ingest, fact: entries).
      const persistedMeta = s.metadata;
      const cacheKey = memoryCacheKey(queryScopeKey, s.id);
      const cachedMeta = this.metadataStore.get(cacheKey);
      const resolvedMeta = persistedMeta ?? cachedMeta;

      const persistedIngestedAt = s.ingestedAt;
      const cachedIngestedAt = this.ingestedAtStore.get(cacheKey);
      const resolvedIngestedAt = persistedIngestedAt ?? cachedIngestedAt;

      return {
        ...s,
        ...(resolvedMeta !== undefined ? { metadata: resolvedMeta } : {}),
        ...(resolvedIngestedAt !== undefined ? { ingestedAt: resolvedIngestedAt } : {}),
      };
    });

    // Optional recency-weighted re-ranking.
    // OFF when `recency` is absent — return withMeta directly (byte-for-byte old behavior).
    if (!this.opts.recency) {
      return { snippets: withMeta };
    }

    // Build an ingestedAt map that merges persisted values (from withMeta) with the
    // in-memory cache. The persisted values already live on the snippet after the map above,
    // so we just need to collect them into a Map for applyRecencyDecay.
    const ingestedAtMerged = new Map<string, number>();
    for (const s of withMeta) {
      if (s.ingestedAt !== undefined) {
        ingestedAtMerged.set(s.id, s.ingestedAt);
      }
    }

    const snippets = applyRecencyDecay(withMeta, this.opts.recency, ingestedAtMerged, Date.parse(this.clock()));
    return { snippets };
  }

  /**
   * Archival dedup/merge (§6.5 duty 2): find near-duplicate archived passages (cosine ≥ threshold),
   * LLM-merge each duplicate pair into ONE canonical passage, and REPLACE the duplicate with the
   * canonical (delete the duplicate's vector + re-upsert the canonical, reconcile FTS). Grounded: the
   * merge must be derived from the inputs. Robust: a malformed merge response leaves BOTH originals
   * intact (never lose data). Surfaces `usage` for cost.background transparency.
   *
   * No-op (returns { merged: 0, usage: 0 }) when semantic is off, no `mergeModel` is given, or the
   * vector adapter cannot `list` a scope.
   *
   * Pair work is bounded by `maxComparisons` (default 100,000). Small scopes whose complete pair
   * count fits the budget retain the historical exhaustive ordering and semantics. Larger scopes use
   * a deterministic widening-window order: all adjacent entries are considered before distance-two
   * entries, and so on, spreading the budget across the full scope. `DedupeResult.truncated` and the
   * comparison counters make partial passes explicit rather than silently skipping the entire scope.
   */
  async deduplicateArchival(scope: Scope, opts: DedupeOptions = {}): Promise<DedupeResult> {
    if (opts.signal?.aborted) throw new DOMException("archival dedup aborted", "AbortError");
    const threshold = opts.threshold ?? 0.95;
    const mergeModel = opts.mergeModel;
    const vector = this.opts.vector;
    const embedder = this.opts.embedder;
    if (!this.semantic || !vector || !embedder || !mergeModel || typeof vector.list !== "function") {
      return { merged: 0, usage: { ...ZERO_USAGE } };
    }
    const sk = scopeKey(scope);
    const entries: VectorEntry[] = await vector.list(sk);
    const comparisonBudget = opts.maxComparisons ?? DEFAULT_DEDUPE_COMPARISON_BUDGET;
    const mergeBudget = opts.maxMerges ?? DEFAULT_DEDUPE_MERGE_BUDGET;
    const mergeTokenBudget = opts.maxMergeTokens ?? DEFAULT_DEDUPE_MERGE_TOKEN_BUDGET;
    if (!Number.isSafeInteger(comparisonBudget) || comparisonBudget < 0) {
      throw new RangeError("Memory.deduplicateArchival: maxComparisons must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(mergeBudget) || mergeBudget < 0) {
      throw new RangeError("Memory.deduplicateArchival: maxMerges must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(mergeTokenBudget) || mergeTokenBudget < 0) {
      throw new RangeError("Memory.deduplicateArchival: maxMergeTokens must be a non-negative safe integer");
    }
    const totalPairs = entries.length * (entries.length - 1) / 2;
    const budgeted = totalPairs > comparisonBudget;
    const merged = new Set<string>();
    let mergedCount = 0;
    let usage: Usage = { ...ZERO_USAGE };
    let comparisons = 0;
    let candidatePairsExamined = 0;
    let truncated = false;

    for (const [i, j] of dedupePairIndices(entries.length, budgeted)) {
      if (opts.signal?.aborted) throw new DOMException("archival dedup aborted", "AbortError");
      if (mergedCount >= mergeBudget || usage.inputTokens + usage.outputTokens >= mergeTokenBudget) {
        truncated = true;
        break;
      }
      // Once fewer than two live entries remain, every later pair would be skipped.
      if (entries.length - merged.size < 2) break;
      if (candidatePairsExamined >= comparisonBudget) {
        truncated = true;
        break;
      }
      candidatePairsExamined += 1;
      const a = entries[i]!;
      if (merged.has(a.id)) continue;
      const b = entries[j]!;
      if (merged.has(b.id)) continue;
      comparisons += 1;
      if (cosineSim(a.vector, b.vector) < threshold) continue;

      const res = await mergeModel.complete({
        messages: [
          { role: "system", content: MERGE_SYSTEM },
          { role: "user", content: `Passage A:\n${a.text}\n\nPassage B:\n${b.text}` },
        ],
        tools: [MERGE_PASSAGES_TOOL],
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      usage = addUsage(usage, res.usage);

      const call = res.content.find((blk) => isToolUse(blk) && blk.name === "merge_passages");
      const canonicalRaw = call && isToolUse(call) ? (call.input as { passage?: unknown }).passage : undefined;
      const canonical = typeof canonicalRaw === "string" ? canonicalRaw.trim() : "";
      if (!canonical) continue; // malformed/empty → DATA SAFETY: leave BOTH intact

      if (opts.signal?.aborted) throw new DOMException("archival dedup aborted", "AbortError");
      const vec = await embedder.embed(canonical);
      await vector.delete(b.id, sk);
      await vector.upsert({ id: a.id, scopeKey: sk, text: canonical, vector: vec });
      await this.opts.store.indexMemory([{ scope, id: a.id, text: canonical }]);
      await this.opts.store.deleteMemory(scope, [b.id]);
      const bCacheKey = memoryCacheKey(sk, b.id);
      this.metadataStore.delete(bCacheKey);
      this.ingestedAtStore.delete(bCacheKey);
      this.textStore.delete(bCacheKey);
      this.scopedIds.get(sk)?.delete(b.id);
      this.textStore.set(memoryCacheKey(sk, a.id), canonical);
      a.text = canonical;
      a.vector = vec;
      merged.add(b.id);
      mergedCount += 1;
    }
    return {
      merged: mergedCount,
      usage,
      comparisons,
      candidatePairsExamined,
      comparisonBudget,
      totalPairs,
      truncated,
      mergeBudget,
      mergeTokenBudget,
    };
  }

  /**
   * Re-embed every archived passage in `scope` using the CURRENT embedder (§19.3).
   * Call this after swapping to a new embedding model/dimension to bring all stored vectors
   * in sync with the new embedder. Returns the count of passages re-indexed.
   *
   * No-op (returns { reindexed: 0 }) when:
   *  - semantic mode is off (no vector + embedder configured), or
   *  - the vector adapter does not implement `list` (no efficient scan available).
   *
   * @param scope - The memory scope whose vectors to re-embed.
   * @param opts.batchSize - How many passages to embed per batch (default: all at once via embedBatch when available, else 1-by-1).
   */
  async reindexEmbeddings(scope: Scope, opts?: { batchSize?: number }): Promise<{ reindexed: number }> {
    const vector = this.opts.vector;
    const embedder = this.opts.embedder;
    if (!this.semantic || !vector || !embedder || typeof vector.list !== "function") {
      return { reindexed: 0 };
    }
    const sk = scopeKey(scope);
    const entries: VectorEntry[] = await vector.list(sk);
    if (entries.length === 0) return { reindexed: 0 };

    const batchSize = opts?.batchSize ?? entries.length;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      if (embedder.embedBatch) {
        const vectors = await embedder.embedBatch(batch.map((e) => e.text));
        await Promise.all(
          batch.map((entry, j) =>
            vector.upsert({ id: entry.id, scopeKey: sk, text: entry.text, vector: vectors[j]! }),
          ),
        );
      } else {
        for (const entry of batch) {
          const vec = await embedder.embed(entry.text);
          await vector.upsert({ id: entry.id, scopeKey: sk, text: entry.text, vector: vec });
        }
      }
    }

    return { reindexed: entries.length };
  }

  /**
   * Upgraded entity signal (improvement 6): rule-based entity extraction from the query
   * (capitalised multi-word sequences, quoted strings, emails, @handles) matched against
   * memory text + KG fact subjects/objects, fused as an additional ranked list into RRF.
   *
   * Scoring: each candidate fact/snippet scores by:
   *   - token overlap (original signal, still present)
   *   - entity string match against fact subject/object (new: +2 per matching entity)
   *
   * Pure TS, no new deps, deterministic.
   */
  private async entitySignal(query: RetrievalQuery, pool: number): Promise<MemorySnippet[]> {
    const tokens = new Set(tokenize(query.text));
    const entities = extractQueryEntities(query.text);
    if (tokens.size === 0 && entities.length === 0) return [];
    // Cap the per-turn full-scope scan to `pool` (Fix §6.4 scaling); pool is already bounded by caller.
    const facts = await this.opts.graph!.queryFacts({ scope: query.scope, limit: pool });
    // Corroboration staleness: when configured, compute a per-fact stale flag against `now`.
    const corrCfg = this.opts.corroborationTtlMs;
    const nowMs = corrCfg !== undefined ? Date.parse(this.clock()) : NaN;
    const scored: MemorySnippet[] = [];
    for (const f of facts) {
      let factText = `${f.subject} ${f.predicate} ${f.object}`;
      const factTextLower = factText.toLowerCase();
      const factTokens = tokenize(factText);

      // Token overlap (original signal)
      let score = 0;
      for (const t of factTokens) if (tokens.has(t)) score += 1;

      // Entity match boost (+2 per matching entity in subject or object)
      const subjectLower = f.subject.toLowerCase();
      const objectLower = f.object.toLowerCase();
      for (const entity of entities) {
        if (subjectLower.includes(entity) || objectLower.includes(entity) || factTextLower.includes(entity)) {
          score += 2;
        }
      }

      if (score > 0) {
        // Corroboration tiers: flag (do NOT drop) facts past their corroboration deadline and
        // annotate the injected text so the agent sees the freshness caveat.
        let stale = false;
        if (corrCfg !== undefined && !Number.isNaN(nowMs)) {
          const window = corroborationWindowFor(corrCfg, f.predicate);
          const lastCorr = f.lastCorroboratedAt ?? Date.parse(f.validFrom);
          if (window !== undefined && !Number.isNaN(lastCorr)) {
            const age = nowMs - lastCorr;
            if (age > window) {
              stale = true;
              factText = `${factText} (last confirmed >${humanizeAge(age)} ago — may be outdated)`;
            }
          }
        }
        scored.push({ id: `fact:${f.id}`, text: factText, score, ...(stale ? { stale: true } : {}) });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, pool);
  }
}
