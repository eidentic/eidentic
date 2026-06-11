# @eidentic/memory

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Clarify public API names (pre-1.0 renames):

  - `LanceVectorStore` → `LanceDBVectorStore` (`@eidentic/lancedb`)
  - `agentRunner` → `createRunner` (`@eidentic/eval`)
  - `discoveryTools` → `lazyDiscoveryTools` (`@eidentic/core`)
  - `dedupeArchival` → `deduplicateArchival` (`@eidentic/memory` — method on `Memory` + `ConsolidationScheduler`)
  - `NoneSandbox` → `NoopSandbox` (`@eidentic/core`)
  - `EAGER_CORE` → `EAGER_TOOL_IDS` (`@eidentic/core`)
  - `globMatch` → `matchSkillGlob` (`@eidentic/skills` only; `@eidentic/core`'s `globMatch` is unchanged)

  Tooling bump (root dev dependency, no changeset required):

  - `typescript` `^5.7.0` → `^5.9.0`

  Note: `@electric-sql/pglite` bump to `^0.5.0` was attempted but reverted — pglite 0.5 removed
  the `./vector` sub-path entirely (pgvector no longer bundled, no standalone replacement package
  available as of 2026-06-07). Staying on `^0.4.6` until upstream ships a compatible upgrade path.

- 3a605b5: Add `Consolidator` — sleep-time memory consolidation (§6.5). It distills raw conversation text/events into durable subject-predicate-object facts via a consolidation model and asserts them into the temporal knowledge graph (`GraphPort`). Grounded reflection drops any fact whose verbatim supporting quote is absent from the source (no ungrounded invention); usage is surfaced for cost transparency. Deferred to later plans: archival dedup/merge, staleness/TTL resolution, block hygiene, durable background scheduling, cost-governor integration.
- 3a605b5: Add `Agent.eraseScope(scope)` — GDPR right-to-erasure fan-out coordinator (§15): one call hard-deletes all of a subject's data across sessions, memory (store + FTS + in-memory metadata/ingestedAt maps), vector store, and graph. `Memory.eraseScope` now also purges in-memory `metadataStore` and `ingestedAtStore` entries via a new scope-to-ids index populated during ingest. Cross-scope isolation guaranteed (erasing user A leaves user B intact); idempotent; adapters without `eraseScope` degrade gracefully (`memorySkipped: true`).
- 3a605b5: Add §15 right-to-erasure: `StorePort.eraseScope` + `VectorPort.deleteScope` + `Memory.eraseScope` — scope-isolated hard-delete across all store and vector adapters; conformance-tested against InMemory, SQLite, libSQL, Postgres (pglite), LanceDB, pgvector (pglite), Qdrant (faithful fake), and Pinecone (faithful fake).
- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Memory completion: passive extraction (§6.8), org/shared scopes (§6.7), block-health (§6.5).

  **`@eidentic/types`** — two new `Scope` kinds:

  - `{ kind: "org"; agentId; orgId }` → `scopeKey` = `org:<agentId>:<orgId>` — tenant-wide institutional knowledge
  - `{ kind: "shared"; blockId }` → `scopeKey` = `shared:<blockId>` — explicitly shared block, intentionally NOT agent-scoped so any two agents resolve the same key (cross-agent sharing, §8)

  **`@eidentic/memory`** — three additions:

  - `passiveExtract(text, subject?)` — deterministic rule-based SPO extraction (NO LLM). Handles: `my name is <Name>` → `(user, name, …)`, `I love/like/prefer/enjoy <thing>` → `(user, likes, …)`, `I work at|for <Company>` → `(user, works_at, …)`, `I work as / I'm a / I am a <role>` → `(user, role|is, …)`. Precision-first (prefers false-negatives over garbage facts); objects capped at 80 chars; identical triples deduped. Exported as `PassiveFact` + `passiveExtract`.
  - `MemoryOptions.extraction?: "agentic" | "passive" | "hybrid"` (default `"agentic"`). When `"passive"` or `"hybrid"` and a `graph` is configured, `ingest` runs `passiveExtract` on every event and asserts each fact with `confidence: 0.6`; failures (temporal-order violations, bad triples) are silently dropped — ingest never throws. `"agentic"` preserves byte-for-byte the previous ingest behavior.
  - `Memory.blockHealth(scope): Promise<BlockHealth[]>` — snapshot of every always-in-context block: `{ label, length, limit?, fillRatio?, isEmpty, required }`. Includes synthetic entries for any `requiredBlocks` label not yet in the store (foundation for §6.5 hygiene nudge). `MemoryOptions.requiredBlocks?: string[]` marks labels as mandatory.

  Deferred: archival dedup/merge, fact-TTL/staleness sweep, durable-background consolidation scheduling, benchmark harness (§6.10).

- 3a605b5: Memory `full`: semantic (vector) recall. New `VectorPort`/`EmbeddingPort`/`RerankPort`; `@eidentic/lancedb` (embedded vector store) and `@eidentic/transformers` (local bge-small embeddings + optional mxbai rerank) adapters; `FullMemory` fuses lexical (FTS5) + vector via RRF with optional reranking. Drop-in: `FullMemory` is a `MemoryPort`, so the agent loop is unchanged.
- 3a605b5: Add `@eidentic/memory` (lite): a drop-in `MemoryPort` (`LiteMemory`) with always-in-context blocks + cross-session lexical/BM25 recall (SQLite FTS5 / in-memory), RRF-fused. The agent loop optionally takes a `MemoryPort` to inject blocks + recalled snippets and ingest conversation text. `StorePort` gains `indexMemory`/`searchMemory`.
- 3a605b5: Complete memory-engine consolidation duties (§6.5 duties 2 & 3, §9.8).

  - **Fact TTL / staleness (duty 3):** `AssertFactInput.ttlMs` stores `Fact.expiresAt = validFrom + ttlMs`; new `GraphPort.sweepExpired(scope, now)` invalidates every currently-valid fact whose `expiresAt <= now` by setting `validUntil = now` — invalidated, NOT deleted (temporal audit, §6.6). Sqlite migration v8 adds `facts.expires_at`. Surfaced as `Memory.sweepExpiredFacts(scope, now?)`. New graph conformance cases.
  - **Archival dedup/merge (duty 2):** `Memory.dedupeArchival(scope, { threshold, mergeModel })` lists a scope's archived passages (new optional `VectorPort.list?`, implemented on the in-memory fake), finds near-duplicates by cosine similarity, LLM-merges each pair into ONE grounded canonical passage, and replaces the duplicate's vector. A malformed merge response leaves both originals intact (never lose data). Merge `usage` surfaced for `cost.background`.
  - **Single-flight scheduler (§9.8):** new in-process `ConsolidationScheduler` runs distillation + staleness sweep + (optional) dedup per scope with single-flight + debounce (a request during a run coalesces into one follow-up), aggregating usage into one `MaintenanceResult.usage`.

  Deferred to later plans: the durable background-job queue with dead-letter (§9), block-hygiene auto-fill/eviction (§6.2), skill-memory rollup, the benchmark harness (§6.10), optimizer-tuned consolidation prompts, and loop wiring of `cost.background`.

- 3a605b5: Memory `retrieve()`: optional recency-weighted ranking. Add `MemoryOptions.recency: { halfLifeMs, weight? }` to blend similarity with an exponential age-decay term (`score = (1-weight)*normSimilarity + weight*exp(-ln2*ageMs/halfLifeMs)`). OFF by default — existing behavior is unchanged when `recency` is omitted. Injectable `now` clock for deterministic tests.
- 3a605b5: fix(memory): robustness hardening — eraseScope best-effort, bounded maps, recency NaN guard, dedup O(n²) cap

  Six audit fixes for `@eidentic/memory`:

  - **FIX 1 (B-P1)** `eraseScope` is now best-effort: each subsystem (store, vector, graph) is
    attempted independently with individual try/catch; in-memory maps are always cleared in a
    `finally`-style block regardless of subsystem errors; an aggregate error is thrown naming
    every failed subsystem after all three attempts complete.

  - **FIX 2 (coordinated)** Updated the vector call from `deleteScope` → `eraseScope` to match
    the `VectorPort` rename in `@eidentic/types`.

  - **FIX 3 (B-P2/E-P1-2)** Added `maxInMemoryEntries` option to `MemoryOptions` to cap the
    `metadataStore` and `ingestedAtStore` maps. When the cap is exceeded, oldest entries are
    evicted first (Map insertion-order LRU); evicted ids are also removed from `scopedIds` to
    keep the erase index in sync. Default: unbounded (no behaviour change for existing callers).

  - **FIX 4 (B-P2)** Recency decay now guards against NaN clocks: if `Date.parse(clock())` or a
    stored `ingestedAt` value is NaN, the recency factor falls back to 1.0 (similarity-only
    ordering) rather than propagating NaN scores. Added JSDoc note on the restart-degradation
    caveat to `RecencyOptions`.

  - **FIX 5 (E-P2)** `deduplicateArchival` retains the existing O(n²) brute-force cosine scan
    (ANN replacement deferred — would change semantics). Added an n > 10_000 safety guard that
    short-circuits with a no-op to prevent runaway cost. Documented the tradeoff in JSDoc.

  - **FIX 6 (C-P2)** `blockHealth` JSDoc now prominently documents the hidden write side-effect:
    calling `getAlwaysInContext` seeds missing configured blocks as a store write.

- 3a605b5: Retrospective security/correctness/performance hardening across the stack:

  - **Session safety:** `Session.open` now binds a session to its `agentId` (opening another agent's session throws), and turn-level event appends that conflict (e.g. a concurrent writer) yield a terminal `result{subtype:"error"}` instead of throwing out of the agent generator.
  - **Prompt-context integrity:** untrusted text (memory block label/value, recall snippets, skill name/description) is escaped when assembled into the `<memory>`/`<recall>`/`<skills>` system-prompt regions, and memory block labels are charset-validated at the tool boundary — preventing delimiter/structure injection.
  - **Scope isolation:** the `memories` re-index delete is now scope-filtered, and `VectorPort.delete` gained a required `scopeKey` argument (implemented across LanceDB/pgvector/Qdrant/Pinecone + fakes) so a duplicated id can't be deleted cross-tenant.
  - **Vector scores unified:** all adapters now report cosine similarity (exact match ≈ 1.0); a conformance case pins this.
  - **Consolidator:** model-supplied `confidence` is clamped to `[0,1]` (also in the `graph_assert` tool); facts rejected by the temporal-order guard are surfaced in a new `ConsolidationResult.rejected` bucket instead of being silently dropped.
  - **Performance:** single store read in `getAlwaysInContext`, targeted `StorePort.getBlock(scope, label)` lookup for block edits, a new `idx_facts_scope_active` index for currently-valid-fact queries, cached session events (no double `readEvents` per turn), and precomputed skill search tokens.

- 3a605b5: Three backward-compatible developer improvements:

  **Feature 1 — Model retry/backoff:** `AgentConfig.modelRetry?: { maxAttempts: number; backoffMs?: number }` retries transient failures (network errors, 429, 5xx) on the `complete()` path only. Streaming is never buffered or retried. `AbortError` is never treated as transient. Default is OFF (no `modelRetry` config).

  **Feature 2 — Per-turn cost visibility:** Every streamed `assistant` event now carries a `usage: Usage` field with that turn's token counts. The terminal `result` event already carried cumulative `usage` and `cost`; this change surfaces the per-turn breakdown mid-run.

  **Feature 3 — RAG citations:** `MemoryEvent` and `MemorySnippet` gain an optional `metadata?: { source?: string; page?: number; [k: string]: unknown }` field. `Memory.ingest` stores it; `Memory.retrieve` returns it per snippet. The `<recall>` block injected into the system prompt now prefixes each snippet with `[source: X]` when `metadata.source` is set — fully backward-compatible when absent. `ingestDocument` attaches `metadata: { source: <url or docId> }` per chunk automatically. Durable-store persistence of metadata is a follow-up.

- 3a605b5: §19 Schema/Prompt Evolution — three concrete, CI-testable pieces:

  **§19.1 Event-schema upcasting** (`@eidentic/types`, `@eidentic/core`):

  - New `upcastEvent` / `upcastEvents` / `Upcaster` / `EventUnupcastableError` / `DEFAULT_UPCASTERS` exported from `@eidentic/types`.
  - `upcastEvents` is wired into `Session.open` (the read path): every replay / resume applies the upcaster chain before the loop sees any event. At v1 with an all-v1 log this is an identity pass (same array reference, zero allocation).
  - `AgentConfig.upcasters?: Record<number, Upcaster>` — inject custom upcasters (merged on top of `DEFAULT_UPCASTERS`). Threaded to all three `Session.open` calls (query, resume, suspension-decision read).
  - `DEFAULT_UPCASTERS` is empty at v1 (no prior version to migrate from). When the schema bumps to v2, add `DEFAULT_UPCASTERS[1] = ...`.

  **§19.3 Embedding-model migration / re-index** (`@eidentic/memory`):

  - New `Memory.reindexEmbeddings(scope, opts?)` — re-embeds every archived passage in `scope` with the CURRENT embedder. Call after swapping to a new model/dimension. Uses `vector.list` + `embedder.embedBatch` (falls back to per-item). Returns `{ reindexed: number }`. No-op when semantic is off or the adapter lacks `list`.

  **§19.4 Instruction/prompt versioning** (`@eidentic/core`, `@eidentic/types`):

  - `AgentConfig.instructionsVersion?: string` — opaque version tag for the agent's instructions.
  - `RunTurnArgs.instructionsVersion?: string` — propagated through to `runTurn` / `resumeTurn`.
  - `StreamEvent["session.init"]` gains an optional `instructionsVersion?: string` field. Present when configured; absent otherwise (byte-identical to previous behavior).

  **Deferred** (noted for the record):

  - §19.2 In-flight version-skew shim (request-level Accept-Version header negotiation for the HTTP server) — deferred; requires server-layer changes and is not testable without a live server.
  - §19.5 / §19.6 Already covered by the existing SQLite migration system (schema-level DB migrations).

- 3a605b5: Self-editing memory blocks (Tier-1): the agent edits its own always-in-context blocks during reasoning via `memory_append` / `memory_replace` / `memory_rewrite` / `memory_archive` tools. Every mutation is recorded in a `block_history` audit trail (new SQLite migration v3 + `StorePort.getBlockHistory`). Guardrails: per-block `limit` and `readOnly` enforcement and compare-and-swap (CAS) on `version` for `replace`/`rewrite`; `append` stays conflict-free. Block metadata lives in the memory-layer config (`blocks: { label: { description, limit, readOnly } }`); `LiteMemory`/`FullMemory` now implement `EditableMemoryPort` via a shared `BlockEditor`. Drop-in unchanged: the editable methods are additive and the no-memory loop path is byte-for-byte identical.
- 3a605b5: Temporal knowledge graph (Tier-4, §6.6): facts are timestamped, invalidatable edges `(subject, predicate, object)`. New `GraphPort` (`assertFact`/`queryFacts`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v4 `facts` table). A contradicting assertion for the same `(subject, predicate)` invalidates the prior fact by setting its `validUntil` — superseded, never deleted — enabling point-in-time ("what was believed at time T") queries. `Memory` gains an optional `graph?: GraphPort`: it delegates `assertFact`/`queryFacts` and folds matching currently-valid facts into recall as a basic entity signal (RRF-fused alongside lexical/semantic). `@eidentic/core` exposes `graph_query` (read-only) and `graph_assert` (destructive) tools to the agent whenever the memory exposes a graph. Drop-in unchanged: graph is opt-in and the no-graph loop/registry path is byte-for-byte identical. Deferred to a later release: sleep-time consolidation agent, episodic→semantic distillation, a normalized `entities` table with entity resolution, and advanced entity-signal fusion.
- 3a605b5: Unify `LiteMemory` and `FullMemory` into a single `Memory` class. `vector` and `embedder` are now optional: omit them for zero-infra lexical recall, provide both for RRF-fused lexical+semantic recall, and add a `reranker` for cross-encoder rerank. "lite" vs "full" is now just whether you wire a vector store — one class with graceful degradation (design §6.12). Construction validates that `vector`/`embedder` are supplied together and that `reranker` is only used with them. `LiteMemory`/`FullMemory` are removed (pre-1.0); migrate to `new Memory({ store })` or `new Memory({ store, vector, embedder })`.

### Patch Changes

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- 3a605b5: Security hardening pass — five audit findings closed (A10, A7, B4, A4, A8, A9, A11).

  **A10 — Recursive secret redaction in logger (`@eidentic/core`)**
  `redactFields` now recurses into nested objects and arrays. String values that match `sk-…` or `Bearer …` patterns are redacted regardless of which key they appear under. Previous behaviour only checked direct top-level key names.

  **A10 — Safe URL in error messages (`@eidentic/tools`)**
  `web_fetch` error messages now use `safeUrlForError()` (new public export), which strips the query string and fragment before including a URL in an error message. This prevents API keys or session tokens passed as query parameters from leaking into logs via error text.

  **A7 — Session-scoped idempotency keys (`@eidentic/core`)**
  `ToolRegistry.runOne` prefixes every durable idempotency key with `${sessionId}:` when a session ID is present. Two sessions that call the same tool with identical arguments no longer share an idempotency ledger entry, eliminating cross-session result suppression and accidental run-skip.

  **B4 — Post-call cost ceiling abort order (`@eidentic/core`)**
  The agent loop now persists and checkpoints the assistant event _before_ aborting on a cost-ceiling breach. Previously the abort could occur before the event was durably written, leaving the session log in an inconsistent state on resume.

  **A4 — `Memory.eraseScope` covers separately-injected `GraphPort` (`@eidentic/types`, `@eidentic/memory`)**
  `GraphPort` gains an optional `eraseScope?(scope): Promise<{ deleted: number }>` method. `Memory.eraseScope` calls it when the injected graph adapter provides the method, enabling full GDPR erasure for graph facts stored in a distinct adapter. Backward-compatible: adapters that do not implement the method see `graph: 0` in the erasure result.

  **A8 — Reserve-then-settle quota to prevent concurrent burst (`@eidentic/server`)**
  `InMemoryQuota.check()` now reserves an in-flight run count and returns a `QuotaReservation` token. Hard-run ceilings are evaluated against `committed + reserved`, so concurrent requests that have not yet settled are visible to each other and cannot collectively exceed the cap. `record(key, spend, reservation)` settles the reservation; `release(reservation)` frees it on the error/abort path. Backward-compatible: callers that omit the `reservation` argument continue to work.

  **A9 — `skill_use` frames skill body in `<skill_reference>` delimiters (`@eidentic/core`)**
  The `skill_use` tool now wraps the returned skill body in `<skill_reference>\n…\n</skill_reference>` before returning it to the model. This makes the boundary between operator-supplied skill content and the conversation unambiguous, reducing prompt-injection risk from malicious skill content.

  **A11 — Construction-time warning for dangerous tools without a permissions policy (`@eidentic/core`)**
  The `Agent` constructor now emits a `warn` log (`eidentic:permission`) when no `permissions` policy is configured but one or more dangerous tools (`bash`, `write_file`, `spawn_agent`, or any `sideEffect: "destructive"` tool) are registered. This is a one-time advisory at construction — no behaviour change.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/types@0.1.0
