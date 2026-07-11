import type { ContentBlock, StoredEvent, Usage, StreamDelta, SuspendDecision, SuspendRequest } from "./protocol.js";

// --- Web search port ---

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchOptions {
  maxResults?: number;
  /** External abort signal. When set, a cancelled agent run will abort the in-flight search. */
  signal?: AbortSignal;
}

/** Provider-agnostic web search (Tavily/Exa/Serper/SearXNG/custom). Model-independent — works for any LLM. */
export interface WebSearchPort {
  search(query: string, opts?: WebSearchOptions): Promise<WebSearchResult[]>;
}

// --- Memory scope ---
export type Scope =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; agentId: string; userId: string }
  | { kind: "thread"; agentId: string; sessionId: string }
  | { kind: "org"; agentId: string; orgId: string }       // tenant-wide institutional knowledge
  | { kind: "shared"; blockId: string };                  // explicitly shared block, cross-agent (§8)

/** Previous delimiter-based scope key. Exported only for controlled migration tooling. */
export const legacyScopeKey = (s: Scope): string => {
  if (s.kind === "agent") return `agent:${s.agentId}`;
  if (s.kind === "user") return `user:${s.agentId}:${s.userId}`;
  if (s.kind === "thread") return `thread:${s.agentId}:${s.sessionId}`;
  if (s.kind === "org") return `org:${s.agentId}:${s.orgId}`;
  // s.kind === "shared" — intentionally NOT agent-scoped; cross-agent by design
  return `shared:${s.blockId}`;
};

/**
 * Stable, injective scope key. Delimiter-free legacy keys remain byte-compatible; scopes whose
 * components contain `:` use a versioned JSON tuple. Ambiguous legacy rows are therefore never
 * silently reassigned to a tenant and require explicit operator mapping.
 */
export const scopeKey = (s: Scope): string => {
  const parts = s.kind === "agent" ? [s.agentId]
    : s.kind === "user" ? [s.agentId, s.userId]
      : s.kind === "thread" ? [s.agentId, s.sessionId]
        : s.kind === "org" ? [s.agentId, s.orgId]
          : [s.blockId];
  return parts.some((part) => part.includes(":"))
    ? `eidentic.scope.v2:${JSON.stringify([s.kind, ...parts])}`
    : legacyScopeKey(s);
};

/** Convenience constructors for stable memory/erasure scopes. */
export const scopes = {
  agent: (agentId: string): Scope => ({ kind: "agent", agentId }),
  user: (agentId: string, userId: string): Scope => ({ kind: "user", agentId, userId }),
  thread: (agentId: string, sessionId: string): Scope => ({ kind: "thread", agentId, sessionId }),
  org: (agentId: string, orgId: string): Scope => ({ kind: "org", agentId, orgId }),
  shared: (blockId: string): Scope => ({ kind: "shared", blockId }),
} as const;

// --- Model port ---
export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] }
  | { role: "tool"; content: string; callId: string; toolName: string };

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSchema[];
  model?: string;
  /** AbortSignal forwarded to the provider for mid-call cancellation (§16.4). Optional; ignored when undefined. */
  signal?: AbortSignal;
  /**
   * Schema-constrained ("structured") output. A JSON Schema describing the object the model
   * should emit as its final answer. When set, a structured-output-capable `ModelPort` constrains
   * the response to this schema and returns the parsed value on `ModelResponse.object`. The schema
   * crosses the port boundary as JSON Schema (same convention as `ToolSchema.inputSchema`); the
   * caller (core) remains responsible for validating the returned object against the source schema.
   * Ports that do not support structured output ignore this field and leave `object` undefined.
   */
  outputSchema?: unknown;
  /**
   * When `true`, the model adapter should mark the stable prompt prefix (system message and,
   * where applicable, tool definitions) as cacheable using the provider's prefix-caching mechanism.
   * Currently implemented for Anthropic via the AI SDK `providerOptions: { anthropic: { cacheControl:
   * { type: "ephemeral" } } }` breakpoint on the system message. Other providers either cache
   * automatically (OpenAI) or silently ignore the hint — no error is thrown.
   *
   * Cache hits are observable via `Usage.cachedInputTokens` / the OTel `kv_cache_hit_rate` attribute.
   * Default: `false` (off). Enabling it is most effective when the system prompt is large and stable
   * across many turns; short or frequently-changing prompts yield negligible savings.
   */
  cacheControl?: boolean;
}

export interface ModelResponse {
  content: ContentBlock[];
  usage: Usage;
  /**
   * Identity of the concrete model that produced this response. Routing/fallback wrappers MUST
   * set this when it differs from their public/default model id so cost and telemetry cannot be
   * attributed to a cheaper route. Direct adapters should set it whenever the provider exposes it.
   */
  resolvedModelId?: string;
  /** Concrete provider identity, when known (for example `openai` or `anthropic`). */
  provider?: string;
  /**
   * Provider-authoritative billable cost for this call in USD. When absent, core derives cost
   * from `resolvedModelId`, `usage`, and the configured price table.
   */
  costUsd?: number;
  /**
   * The structured object the model produced when `ModelRequest.outputSchema` was set and the
   * turn emitted a structured final answer (no pending tool calls). Undefined otherwise — e.g.
   * the model chose to call a tool this turn, or the request carried no `outputSchema`.
   */
  object?: unknown;
}

export type ModelStreamPart =
  | { type: "delta"; delta: StreamDelta }
  | { type: "final"; response: ModelResponse };

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelStreamPart>;
  /** Optional: the model's own identifier (e.g. "claude-sonnet-4-5"). When set, it is used as the default modelId in session.init. */
  modelId?: string;
}

// --- Memory block ---
export interface MemoryBlock {
  label: string;
  value: string;
  version: number;
  updatedAt: string;
  /** Layer-config metadata (populated by the memory layer; the store leaves these undefined). */
  description?: string;
  limit?: number;
  readOnly?: boolean;
}

/** One committed version of a block, for the audit/rollback trail (ascending by version). */
export interface BlockHistoryEntry {
  label: string;
  value: string;
  version: number;
  updatedAt: string;
}

/** Result of a self-edit. On failure, `current` (when present) is the freshest store state. */
export type BlockEdit =
  | { ok: true; block: MemoryBlock }
  | { ok: false; reason: "conflict" | "readonly" | "limit" | "notfound" | "missing"; message: string; current?: MemoryBlock };

// --- Memory recall (lexical for lite; RRF-fused, vector signal added later) ---
export interface RetrievalQuery {
  text: string;
  scope: Scope;
  topK?: number;
}
export interface MemorySnippet {
  id: string;
  text: string;
  score: number;
  /** Source citation metadata forwarded from the ingested MemoryEvent (when present). */
  metadata?: { source?: string; page?: number; [k: string]: unknown };
  /**
   * Epoch-milliseconds at which this entry was ingested. Populated by `searchMemory`
   * when the store has been migrated to include the `ingested_at` column (v10+ for
   * sqlite/libsql, v8+ for postgres). Absent on older stores or pre-migration rows.
   */
  ingestedAt?: number;
  /**
   * Staleness flag (corroboration tiers). Set to `true` on knowledge-graph-derived snippets whose
   * `lastCorroboratedAt` is older than the configured `corroborationTtlMs` deadline. Stale snippets
   * are NOT dropped — they are flagged so the context-injection layer can annotate them
   * (e.g. "(last confirmed >90d ago — may be outdated)"). Undefined/absent means not stale (or the
   * corroboration feature is off). Only graph-fact snippets carry this; lexical/vector snippets never do.
   */
  stale?: boolean;
}
export interface RetrievedMemory {
  snippets: MemorySnippet[];
}
export interface MemoryEvent {
  id: string;
  scope: Scope;
  text: string;
  /**
   * Optional acting-user identity for multi-tenant scopes (org/shared).
   * When set, passive extraction uses this as the fact subject instead of deriving
   * one from the scope alone — preventing facts from different real users from collapsing
   * onto the same subject and triggering spurious temporal contradictions (§6.8 multi-tenant fix).
   */
  subject?: string;
  /**
   * Optional provenance metadata. Stored alongside the snippet and returned by `retrieve` so
   * recall-injected context can carry source citations. Common fields: `source` (URL or docId),
   * `page` (0-based page number). Any additional keys are allowed (open-ended record).
   *
   * Durable-store persistence of metadata is threaded through the in-memory/recall path;
   * persistence in SQL store backends is a follow-up (the SQL FTS index stores text only).
   */
  metadata?: { source?: string; page?: number; [k: string]: unknown };
}

/** Drop-in memory contract (depends only on @eidentic/types). */
export interface MemoryPort {
  getAlwaysInContext(scope: Scope): Promise<MemoryBlock[]>;
  retrieve(query: RetrievalQuery): Promise<RetrievedMemory>;
  ingest(events: MemoryEvent[]): Promise<void>;
}

/** A `MemoryPort` whose Tier-1 blocks the agent can edit during reasoning. */
export interface EditableMemoryPort extends MemoryPort {
  append(scope: Scope, label: string, text: string): Promise<BlockEdit>;
  replace(scope: Scope, label: string, find: string, replace: string, version: number): Promise<BlockEdit>;
  rewrite(scope: Scope, label: string, value: string, version: number): Promise<BlockEdit>;
  archive(scope: Scope, text: string): Promise<void>;
}

// --- Vector / embedding / rerank (memory: full) ---
export interface VectorEntry {
  id: string;
  scopeKey: string; // pre-computed scope key (use scopeKey(scope))
  text: string;
  vector: number[];
}
export interface VectorSearchResult {
  id: string;
  text: string;
  score: number; // higher = more relevant
}
export interface VectorPort {
  upsert(entry: VectorEntry): Promise<void>;
  search(queryVector: number[], scopeKey: string, topK?: number): Promise<VectorSearchResult[]>;
  delete(id: string, scopeKey: string): Promise<void>;
  /**
   * Hard-delete ALL vectors for `scopeKey` (GDPR right-to-erasure, §15). Returns the count of
   * entries removed. Scope-isolated — other scopeKeys are untouched.
   */
  eraseScope(scopeKey: string): Promise<{ deleted: number }>;
  /**
   * Optional: enumerate all entries in a scope (for archival dedup, §6.5 duty 2). Absent on adapters
   * with no efficient scan — callers (e.g. `Memory.deduplicateArchival`) treat a missing `list` as a no-op.
   */
  list?(scopeKey: string): Promise<VectorEntry[]>;
}
export interface EmbeddingPort {
  readonly dim: number;
  embed(text: string): Promise<number[]>;
  /**
   * Optional batch embedding for efficiency on the ingest hot path. When present, callers
   * (e.g. `Memory.ingest`) embed all texts in a single call instead of N sequential calls.
   * Each returned vector must have length === `dim`. Falls back gracefully to per-item `embed`
   * when absent, so existing embedder implementations need not implement this.
   */
  embedBatch?(texts: string[]): Promise<number[][]>;
}
export interface RerankPort {
  rerank(query: string, candidates: VectorSearchResult[]): Promise<VectorSearchResult[]>;
}

// --- Session record ---
export interface SessionRecord {
  id: string;
  agentId: string;
  createdAt: string;
  /** The user who owns this session (Fix 1: multi-tenant ownership). Nullable for legacy/NoAuth sessions. */
  userId?: string;
  /** The org that owns this session (Fix 1: multi-tenant ownership). Nullable for legacy/NoAuth sessions. */
  orgId?: string;
  /**
   * Opaque credential fingerprint for an apiKey-only owner. Despite the legacy field name, new
   * writes MUST NOT store a presented API key. Existing plaintext rows are upgraded on verified use.
   */
  apiKey?: string;
}

/** One durable lexical-memory entry, without retrieval-only score fields. */
export interface MemoryEntry {
  id: string;
  text: string;
  ingestedAt?: number;
  metadata?: Record<string, unknown>;
}

// --- Store port ---
export interface StorePort {
  migrate(): Promise<void>;
  createSession(s: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Compare-and-swap a legacy session credential to an opaque fingerprint. */
  replaceSessionApiKey(sessionId: string, expected: string, replacement: string): Promise<boolean>;
  appendEvents(events: StoredEvent[]): Promise<void>;
  readEvents(sessionId: string): Promise<StoredEvent[]>;
  getBlocks(scope: Scope): Promise<MemoryBlock[]>;
  getBlock(scope: Scope, label: string): Promise<MemoryBlock | null>;
  upsertBlock(scope: Scope, block: { label: string; value: string }, expectVersion?: number): Promise<MemoryBlock>;
  appendBlock(scope: Scope, label: string, text: string): Promise<MemoryBlock>;
  /** Full ascending version trail for one block; [] when the block has no history. Scope-isolated. */
  getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]>;
  /**
   * Index memory entries. The optional `ingestedAt` (epoch-ms) and `metadata` fields are
   * persisted when the underlying store supports them (added in migration v10/v8 for
   * sqlite/libsql and postgres respectively). Older stores that do not yet support these
   * columns silently ignore them — callers must tolerate NULL on the read path.
   */
  indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>): Promise<void>;
  /**
   * Search memory. The returned snippets include `ingestedAt` (epoch-ms) and `metadata`
   * when available (i.e. when the store was migrated to at least v10/v8). Both fields are
   * optional — callers must handle absent values gracefully.
   */
  searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]>;
  /** Enumerate every lexical memory entry in one exact scope for export/consent governance. */
  listMemory(scope: Scope): Promise<MemoryEntry[]>;
  /** Delete exact lexical memory ids in one exact scope. Returns rows actually removed. */
  deleteMemory(scope: Scope, ids: string[]): Promise<number>;
  /**
   * Hard-delete ALL data for `scope` (GDPR right-to-erasure, §15): matching sessions and their
   * events/checkpoints/idempotency records/suspension decisions, plus blocks, block_history,
   * memories (lexical index), and facts (the temporal KG). Session matching is exact: agent erases
   * every session for that agent; user/org match both agentId and owner; thread matches agentId and
   * sessionId; shared erases no sessions. Returns the count of rows removed. Irreversible.
   * Scope-isolated — other scopes are untouched.
   */
  eraseScope(scope: Scope): Promise<{ deleted: number }>;
  /**
   * List sessions newest-first, optionally filtered. For studio/admin UIs.
   * Fix 2: when `userId`, `orgId`, or `apiKey` is provided, only returns sessions that match exactly
   * (sessions with no recorded owner are excluded when a filter is set — strict mode).
   */
  listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string; apiKey?: string }): Promise<SessionRecord[]>;
  /** List all memory blocks for a scope. For studio/admin UIs. */
  listBlocks(scope: Scope): Promise<MemoryBlock[]>;
  close(): Promise<void>;
}

/** Result of an explicit, operator-authorized legacy scope-key migration. */
export interface LegacyScopeMigrationResult {
  /** Rows whose scope key changed from `legacyScopeKey(scope)` to `scopeKey(scope)`. */
  migrated: number;
}

/**
 * Optional capability implemented by first-party persistent stores.
 *
 * This is deliberately not an automatic read fallback: delimiter-based legacy keys can be
 * ambiguous. An operator must supply the authoritative logical scope. Implementations refuse to
 * merge into an already-populated v2 target, so a mistaken mapping cannot silently combine tenants.
 */
export interface LegacyScopeMigratableStorePort {
  migrateLegacyScope(scope: Scope): Promise<LegacyScopeMigrationResult>;
}

// --- Temporal knowledge graph (Tier-4) ---

/** A timestamped, invalidatable edge. `object` is a plain string (entity name OR literal) in 7a. */
export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  objectKind: "entity" | "literal";
  validFrom: string;            // ISO timestamp
  validUntil?: string;          // set when invalidated/superseded (else currently valid)
  confidence: number;           // 0..1
  source?: string;              // provenance: event id
  /** Optional staleness deadline (§6.5 duty 3). When set and expiresAt <= now, sweepExpired
   *  invalidates by setting validUntil=now (NOT deleting — temporal audit §6.6). */
  expiresAt?: string;
  /**
   * State-transition link (evolution, not replacement). When this fact superseded a prior fact
   * for the same (scope, subject, predicate) at assert time (contradiction-invalidation), this
   * holds the prior fact's `id`. Set automatically inside the assert transaction; undefined for
   * the first fact in a chain or facts asserted with no prior currently-valid fact. The full
   * version timeline is reconstructable via `GraphPort.factHistory`.
   */
  supersedes?: string;
  /**
   * Corroboration timestamp (epoch-ms). The last time this fact was re-confirmed — defaults to the
   * fact's `validFrom` (converted to epoch-ms) at assert time, and is bumped by `GraphPort.corroborate`
   * whenever a still-valid fact is re-observed (e.g. the Consolidator sees the same triple again).
   * Used together with `MemoryOptions.corroborationTtlMs` to flag high-confidence facts that may have
   * gone stale ("last confirmed >Nd ago"). Undefined on facts written before this field existed.
   */
  lastCorroboratedAt?: number;
}

export interface AssertFactInput {
  subject: string;
  predicate: string;
  object: string;
  objectKind?: "entity" | "literal"; // default "literal"
  validFrom?: string;                // default: injected clock (caller may pass explicit time)
  confidence?: number;               // default 1
  source?: string;
  /** When set, assertFact stores expiresAt = validFrom + ttlMs (milliseconds). */
  ttlMs?: number;
  /**
   * Explicit staleness deadline override (ISO). When set, assertFact stores this as `expiresAt`
   * verbatim instead of deriving it from `ttlMs`. Used by re-assertion paths (e.g. scope merge,
   * consent retention) that need to preserve a fact's original expiry rather than recompute it.
   * `ttlMs` takes precedence when both are supplied.
   */
  expiresAt?: string;
  /**
   * Pre-set corroboration timestamp (epoch-ms). When set, the asserted fact's `lastCorroboratedAt`
   * is initialised to this value instead of defaulting to `validFrom`. Used by re-assertion paths
   * (scope merge) that preserve a fact's prior corroboration state. Defaults to `validFrom` (epoch-ms).
   */
  lastCorroboratedAt?: number;
}

export interface FactQuery {
  scope: Scope;
  subject?: string;
  predicate?: string;
  object?: string;
  validAt?: string;            // point-in-time; omitted => currently-valid only (validUntil IS NULL)
  includeInvalidated?: boolean; // when true and validAt omitted, return ALL (valid + invalidated)
  /** Cap the number of returned rows (applied after filtering). Useful for bounding full-scope scans. */
  limit?: number;
}

/**
 * Temporal knowledge graph (§6.6). Separate from StorePort; an adapter MAY implement both.
 * Contradiction rule (functional predicate): asserting (subject, predicate) with a DIFFERENT
 * object than an existing currently-valid fact (same scope+subject+predicate, validUntil null)
 * INVALIDATES the prior fact by setting its validUntil = newFact.validFrom (NOT deleted).
 * Re-asserting the SAME object on a currently-valid fact is idempotent. Scope-isolated.
 *
 * NOTE on shared-scope sessions: when `store` and `graph` point to the same underlying adapter
 * (the common `InMemoryStore` / `SqliteStore` case), `StorePort.eraseScope` already deletes facts
 * as part of the unified row-delete. A SEPARATELY-INJECTED `GraphPort` adapter (one that writes
 * facts to its own storage — e.g. a dedicated graph database) must also implement `eraseScope`
 * so that `Memory.eraseScope` can clean both subsystems. If your `graph` shares the same storage
 * as your `store`, you can safely leave `eraseScope` as a no-op that returns `{ deleted: 0 }`.
 */
export interface GraphPort {
  assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }>;
  queryFacts(query: FactQuery): Promise<Fact[]>;
  /**
   * State-transition timeline (evolution, not replacement): return the FULL version history for one
   * (scope, subject, predicate) — every fact ever asserted, valid or invalidated, ordered ascending
   * by `validFrom`. Equivalent to `queryFacts({ scope, subject, predicate, includeInvalidated: true })`
   * but named for intent and free to follow `supersedes` links. The `supersedes` field on each
   * returned fact links it to the prior version it replaced. Scope-isolated.
   */
  factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]>;
  /**
   * Corroboration (staleness tiers): re-confirm a still-valid fact by bumping its `lastCorroboratedAt`
   * to `at` (epoch-ms; defaults to now). Cheap UPDATE — no new row, no invalidation. A no-op if the
   * fact id does not exist or is already invalidated. Returns the count updated (0 or 1). Scope-isolated.
   */
  corroborate(scope: Scope, factId: string, at?: number): Promise<number>;
  /**
   * Invalidate a specific set of currently-valid facts by id (consent enforcement, §15). Sets
   * `validUntil = at` on each currently-valid fact whose id is in `ids` (audit-preserving — NOT
   * deleted). Already-invalidated facts and ids in other scopes are ignored. Returns the count
   * invalidated. Scope-isolated.
   *
   * BACKWARD COMPATIBILITY: optional. `Memory.applyConsent` calls it only when present; an adapter
   * that omits it simply cannot retroactively sweep facts (memory entries are still swept).
   */
  expireFacts?(scope: Scope, ids: string[], at: string): Promise<number>;
  /**
   * Staleness sweep (§6.5 duty 3). Invalidates every currently-valid fact in `scope` whose
   * `expiresAt` is non-null and `<= now` by setting `validUntil = now` (NOT deleting — temporal
   * audit, §6.6). Returns the count invalidated. Scope-isolated; non-expiring facts untouched.
   */
  sweepExpired(scope: Scope, now: string): Promise<number>;
  /**
   * GDPR right-to-erasure (§15): hard-delete ALL facts for `scope` from this graph store.
   * Returns the count of fact rows removed. Irreversible. Scope-isolated.
   *
   * BACKWARD COMPATIBILITY: optional — existing adapters that do not implement this method are
   * accepted. `Memory.eraseScope` calls it only when present. When `graph` shares storage with
   * `store` (e.g. `SqliteStore` implements both), `StorePort.eraseScope` already covers facts;
   * implementing a no-op `() => Promise.resolve({ deleted: 0 })` is sufficient in that case.
   */
  eraseScope?(scope: Scope): Promise<{ deleted: number }>;
}

// --- Consent / privacy architecture (§15) ---

/**
 * Per-category retention policy:
 *   - "never"   — content in this category is rejected at write time (never persisted).
 *   - "session" — kept only for a short session-scoped TTL (applied as a fact TTL / memory expiry).
 *   - number    — retention in milliseconds; content expires that long after it was written.
 */
export type ConsentPolicy = "never" | "session" | number;

/**
 * A consent manifest governs which categories of personal data the memory system may retain and
 * for how long. Categories are arbitrary string labels (e.g. "health", "location", "contact-info").
 * The optional `classify` callback maps a piece of text (and, when available, the structured fact it
 * produced) to a category; when omitted, the built-in `defaultConsentClassifier` is used.
 *
 * Enforcement is at WRITE time (reject "never", short-TTL "session", retention-TTL number) and can be
 * applied RETROACTIVELY via `Memory.applyConsent` (sweeps existing data of now-forbidden categories).
 */
export interface ConsentManifest {
  /** Category → policy. Categories not listed here are unrestricted (retained indefinitely). */
  categories: Record<string, ConsentPolicy>;
  /**
   * Classify a piece of text into a category, or undefined if none applies. `fact` is provided when
   * the text produced a structured triple (so the classifier can inspect predicate/object too).
   * Defaults to `defaultConsentClassifier` when omitted.
   */
  classify?: (text: string, fact?: Fact) => string | undefined;
  /**
   * TTL (ms) applied to "session"-policy content. Defaults to 30 minutes when omitted. Kept on the
   * manifest so the same policy is honoured at both write time and retroactive sweep time.
   */
  sessionTtlMs?: number;
}

/** Audit result of a consent enforcement pass (write-time rejections or retroactive sweep). */
export interface ConsentResult {
  /** Number of facts/memories rejected outright (category "never"). */
  rejected: number;
  /** Number of existing facts invalidated by a retroactive `applyConsent` sweep. */
  sweptFacts: number;
  /** Number of existing memory entries erased by a retroactive `applyConsent` sweep. */
  sweptMemories: number;
}

// --- Portable export (§15 data-subject-access / portability) ---

/** Versioned, structured snapshot of everything stored for one scope (the portability artifact). */
export interface MemoryExport {
  /** Schema envelope discriminator. */
  schema: "eidentic.memory.export.v1";
  /** When this export was produced (ISO). */
  exportedAt: string;
  /** The scope the export covers. */
  scope: Scope;
  /** Lexical memory entries (text + provenance + ingest metadata). */
  memories: Array<{ id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>;
  /** Full temporal knowledge-graph facts (all versions, incl. supersedes + lastCorroboratedAt). */
  facts: Fact[];
  /** Always-in-context blocks at current version. */
  blocks: MemoryBlock[];
  /** Per-block version history (when cheaply available). */
  blockHistory: Record<string, BlockHistoryEntry[]>;
}

// --- Durable execution (§9): checkpoint-resume journal + idempotency ledger ---

/** A content-addressed marker over the replay-state event log (§9.1 projection 1). */
export interface Checkpoint {
  sessionId: string;
  seq: number;        // the session's next-seq at checkpoint time (events [0, seq) are durable)
  hash: string;       // replayHash of events so far, EXCLUDING meta
  createdAt: string;
}

export type IdempotencyStatus = "intent" | "applied";

export interface IdempotencyMetadata {
  /**
   * Optional logical memory scope. Convex public handlers can use this in authorization hooks
   * instead of parsing it back out of an opaque idempotency key.
   */
  scopeKey?: string;
  /** Optional session owner for durable tool keys, usually the caller's sessionId. */
  sessionId?: string;
  /** Optional host-defined owner key, such as a workspace/user/org principal. */
  ownerKey?: string;
}

/** One ledger row: intent written before a side-effecting tool runs, flipped to applied after. */
export interface IdempotencyRecord extends IdempotencyMetadata {
  key: string;
  argsHash: string;
  status: IdempotencyStatus;
  result?: unknown;   // present once status === "applied"
  createdAt: string;
}

/**
 * Durable-execution substrate (§9.6 embedded default). Separate from StorePort; an adapter MAY
 * implement both. Two responsibilities: checkpoint markers (resume) and an idempotency ledger
 * (exactly-once side effects, §9.3 intent/completion records).
 */
export interface DurablePort {
  /** Write a checkpoint marker for (sessionId, seq). Idempotent per (sessionId, seq). */
  writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void>;
  /** The highest-seq checkpoint for the session, or null if none. */
  lastCheckpoint(sessionId: string): Promise<Checkpoint | null>;
  /** Record intent BEFORE a destructive/idempotent tool runs. No-op if the key already exists. */
  recordIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<void>;
  /**
   * Atomically claim a previously unseen idempotency key.
   *
   * Returns `true` only for the single caller that inserted the intent. `false` means another
   * executor already owns, or has completed, the key. Callers MUST NOT execute the side effect
   * after a `false` result; they should inspect `getIdempotency()` instead.
   */
  claimIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean>;
  /** Release this exact, still-pending claim when execution suspends before the side effect. */
  releaseIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean>;
  /** Flip the key to applied AFTER it succeeds, persisting the result for skip-on-resume. */
  recordCompletion(key: string, result: unknown, metadata?: IdempotencyMetadata): Promise<void>;
  /** Read the ledger row (with parsed result) for a key, or null if absent. */
  getIdempotency(key: string, metadata?: IdempotencyMetadata): Promise<IdempotencyRecord | null>;
  /**
   * Human-in-the-loop suspension (§9.4). Persist the human decision for a suspended tool call,
   * keyed by (sessionId, callId) so the same key is stable across the original run and the resume.
   * Write-once per (sessionId, callId) — a re-record is a no-op (last write may overwrite in v1; tests
   * do not re-record the same key, so adapters MAY choose upsert or insert-or-ignore).
   */
  recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void>;
  /** Read the recorded decision for (sessionId, callId), or null if none recorded yet. */
  getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null>;
}

// Re-export suspension types for ports.ts consumers (defined in protocol.ts to avoid a cycle).
export type { SuspendRequest, SuspendDecision } from "./protocol.js";

// --- Auth port (§13 / §0-A) ---

/** A minimal, framework-agnostic view of an inbound request for authentication. */
export interface AuthRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
}

/** The authenticated principal; maps to a Eidentic Scope (userId/orgId) + the API key for quotas/rate-limits. */
export interface AuthPrincipal {
  userId?: string;
  orgId?: string;
  apiKey?: string;
}

/** Authenticates an inbound request. Returns null to reject (server responds 401). */
export interface AuthPort {
  authenticate(req: AuthRequest): Promise<AuthPrincipal | null> | AuthPrincipal | null;
}

// --- Rate limiter (§20.3) ---

/** Outcome of a rate-limit check. `retryAfterMs` is set when not allowed. */
export interface RateLimitResult { ok: boolean; retryAfterMs?: number; remaining?: number; }

/** Token-bucket-style tenant rate limiter (§20.3). `key` is a tenant key (apiKey/org/user). */
export interface RateLimiterPort {
  /** Try to consume `cost` tokens for `key`. Returns ok=false + retryAfterMs when throttled. */
  acquire(key: string, cost?: number): Promise<RateLimitResult> | RateLimitResult;
}

// --- Quota port (§20.4) ---

/** Cumulative tenant usage counters (since the ledger's window start). */
export interface QuotaUsage { usd: number; tokens: number; runs: number; }

/** Per-tenant ceilings. Omit a field for "no limit". soft* → warn; hard* → block. */
export interface QuotaLimits {
  hardUsd?: number;
  softUsd?: number;
  hardTokens?: number;
  hardRuns?: number;
}

/** Outcome of a quota check. ok=false blocks; warn=true is a soft-cap signal (still allowed). */
export interface QuotaCheck { ok: boolean; warn?: boolean; reason?: string; usage?: QuotaUsage; }

/** Per-tenant cumulative quota ledger (§20.4). `key` is a tenant key (apiKey/org/user). */
export interface QuotaPort {
  /** Check whether `key` may start another run. */
  check(key: string): Promise<QuotaCheck> | QuotaCheck;
  /**
   * Record a completed run's spend for `key` (tokens+usd from CostBreakdown, +1 run).
   * The optional `reservation` token, when provided, settles an in-flight reservation
   * previously returned by `check` — freeing the reserved slot and replacing it with the
   * actual spend. Callers that omit `reservation` are still supported (backward-compatible).
   */
  record(key: string, spend: { usd: number; tokens: number }, reservation?: unknown): Promise<void> | void;
  /**
   * Optional: release a reservation without recording spend (e.g. the run was aborted before
   * any tokens were consumed). When present, callers SHOULD call this instead of `record` on
   * abort so the reserved slot is freed immediately rather than waiting for the sweep.
   */
  release?(reservation: unknown): void | Promise<void>;
}

// --- Skill substrate (§7, v1) ---

/** Tier-1 catalog entry: always-in-context name + description (the trigger signal). */
export interface SkillCatalogEntry {
  name: string;
  description: string;
}

/** Provenance record computed on load (§7.6, substrate only — recorded, not enforced in v1). */
export interface SkillProvenance {
  source: string;        // dir path, "inline", or other origin
  contentHash: string;   // sha256 of the raw SKILL.md content
  author?: string;       // human/agent author when known
}

/** Result of `skill_use`: Tier-2 body + (Tier-3) relevant per-skill memory + provenance. */
export interface LoadedSkill {
  name: string;
  description: string;
  body: string;               // the SKILL.md markdown body (Tier-2)
  /** Tool ids permitted while this skill is active; enforced by core dispatch. */
  allowedTools?: string[];
  memory?: string;            // relevant `.memory.md` slice (Tier-3)
  provenance?: SkillProvenance;
  /** Relative paths of Tier-3 reference/script/asset files (pointer catalog — content loaded on demand via skill_read). */
  references?: string[];
}

/**
 * Drop-in skill contract (depends only on @eidentic/types). Mirrors MemoryPort:
 * `catalog()` is the always-in-context Tier-1 region; `search`/`use` are the discovery/
 * invocation API (§7.8); `recordOutcome` appends to per-skill memory (§7.5).
 */
export interface SkillPort {
  catalog(): SkillCatalogEntry[];                            // Tier-1, always-in-context
  search(query: string, topK?: number): SkillCatalogEntry[]; // description scoring (Tier-1)
  use(name: string): Promise<LoadedSkill | null>;            // Tier-2/3 load
  recordOutcome(name: string, note: string): Promise<void>;  // append to per-skill memory
  /** Read a specific Tier-3 file from a skill's directory (path-confined). Optional; absent on in-memory sets. */
  read?(name: string, path: string): Promise<string | null>;
}
