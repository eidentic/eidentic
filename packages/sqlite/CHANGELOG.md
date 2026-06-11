# @eidentic/sqlite

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Lazy-load `better-sqlite3` so importing `@eidentic/sqlite` (and the `eidentic` umbrella) is safe on any runtime — only `new SqliteStore()` needs the native addon. Moves `better-sqlite3` to `optionalDependencies`; on Deno/edge/Workers use `@eidentic/libsql` (Turso) or `@eidentic/postgres` instead.
- 3a605b5: Durable execution substrate (§9, embedded default): crash-resume + exactly-once side effects. New `DurablePort` (`writeCheckpoint`/`lastCheckpoint` + idempotency ledger `recordIntent`/`recordCompletion`/`getIdempotency`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v6: `checkpoints` + `idempotency_keys` tables), with a shared `durableConformanceCases` suite. Tools gain an optional `idempotencyKey`; when a run is durable, `ToolRegistry.dispatch` writes an intent before a side-effecting tool runs and a completion after — on re-dispatch a key already `applied` returns the cached result WITHOUT executing (exactly-once). The loop checkpoints after each model call and tool batch via a deterministic `replayHash` (content hash over `{kind, payload}`, excluding cost/timing `meta`), and a new `Agent.resume(sessionId)` continues an interrupted run from the persisted event log with idempotency active, so already-applied side effects (payments, emails, writes) are skipped, not re-run. Opt-in via `durable: true` (requires a store implementing `DurablePort`); the fast path (`durable` falsy) is byte-for-byte unchanged. A §18.4 crash-injection test proves a destructive tool's external counter stays at 1 across a crash-and-resume. Deferred: pluggable durable-execution adapters (§9.6), distributed sagas, fork/time-travel (§9.7), progress-gated retries + circuit breaker + backoff, human-in-the-loop durable suspension (§9.4), and cross-version workflow migration (§19).
- 3a605b5: Add §15 right-to-erasure: `StorePort.eraseScope` + `VectorPort.deleteScope` + `Memory.eraseScope` — scope-isolated hard-delete across all store and vector adapters; conformance-tested against InMemory, SQLite, libSQL, Postgres (pglite), LanceDB, pgvector (pglite), Qdrant (faithful fake), and Pinecone (faithful fake).
- 3a605b5: Human-in-the-loop durable suspension (§5.7 / §9.4). A tool can `await ctx.suspend({ reason, present })` to pause a run for human input/approval: the run persists and consumes NO compute while waiting, yields a terminal `subtype: "suspended"` result carrying the request + callId, and later `agent.resume(sessionId, { decision })` records the decision and continues — the suspended tool re-runs and `ctx.suspend` returns the injected `{ approved, data? }`, so the tool's real side effect runs EXACTLY ONCE behind that gate. Built on the Plan 9a durable substrate: new `DurablePort.recordDecision`/`getDecision` (keyed by `(sessionId, callId)`) implemented by `InMemoryStore` + `SqliteStore` (new migration v7 `suspension_decisions`), covered by `durableConformanceCases`. The loop appends a `"suspension"` audit event (ignored on replay, like `compaction`) and folds it into the rolling checkpoint hash; `ctx.suspend` requires durable execution (clear error otherwise), and a suspending tool produces no tool_result (the `SuspendSignal` is propagated to the loop, never swallowed into a tool error). Complements the Plan 10 permission "ask" gate. Deferred: cryptographic/passkey approval UX (§10.5), a hosted approval queue/notification system, multi-party approvals, and timeout/auto-deny policies.
- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Add `@eidentic/memory` (lite): a drop-in `MemoryPort` (`LiteMemory`) with always-in-context blocks + cross-session lexical/BM25 recall (SQLite FTS5 / in-memory), RRF-fused. The agent loop optionally takes a `MemoryPort` to inject blocks + recalled snippets and ingest conversation text. `StorePort` gains `indexMemory`/`searchMemory`.
- 3a605b5: Complete memory-engine consolidation duties (§6.5 duties 2 & 3, §9.8).

  - **Fact TTL / staleness (duty 3):** `AssertFactInput.ttlMs` stores `Fact.expiresAt = validFrom + ttlMs`; new `GraphPort.sweepExpired(scope, now)` invalidates every currently-valid fact whose `expiresAt <= now` by setting `validUntil = now` — invalidated, NOT deleted (temporal audit, §6.6). Sqlite migration v8 adds `facts.expires_at`. Surfaced as `Memory.sweepExpiredFacts(scope, now?)`. New graph conformance cases.
  - **Archival dedup/merge (duty 2):** `Memory.dedupeArchival(scope, { threshold, mergeModel })` lists a scope's archived passages (new optional `VectorPort.list?`, implemented on the in-memory fake), finds near-duplicates by cosine similarity, LLM-merges each pair into ONE grounded canonical passage, and replaces the duplicate's vector. A malformed merge response leaves both originals intact (never lose data). Merge `usage` surfaced for `cost.background`.
  - **Single-flight scheduler (§9.8):** new in-process `ConsolidationScheduler` runs distillation + staleness sweep + (optional) dedup per scope with single-flight + debounce (a request during a run coalesces into one follow-up), aggregating usage into one `MaintenanceResult.usage`.

  Deferred to later plans: the durable background-job queue with dead-letter (§9), block-hygiene auto-fill/eviction (§6.2), skill-memory rollup, the benchmark harness (§6.10), optimizer-tuned consolidation prompts, and loop wiring of `cost.background`.

- 3a605b5: feat(security): multi-tenant session ownership, listSessions filtering, IDOR fix, A2A auth

  Fix 1 — Session ownership: `SessionRecord` gains optional `userId`/`orgId` fields. All three
  stores (sqlite/libsql/postgres) add migration v9 (sqlite/libsql) / v7 (postgres) to add
  nullable `user_id`/`org_id` columns. `createSession` persists them; `getSession` returns them.
  `Agent.query`/`resume` thread `userId`/`orgId` from `QueryOptions` into `Session.open` so
  the owner is recorded on the first turn.

  Fix 2 — `listSessions` by principal: `StorePort.listSessions` accepts optional `userId` and
  `orgId` filter options. All three stores + `InMemoryStore` implement strict filtering (only
  exact matches returned; sessions with no owner are excluded when a filter is provided).
  Two new shared `storeConformanceCases` verify the behaviour.

  Fix 3a — Server IDOR prevention: the `resume` and `events` routes now load the `SessionRecord`
  and check that the authenticated principal's `userId`/`orgId` matches. Sessions with no
  recorded owner (legacy / NoAuth) are allowed through for backward compatibility. Returns 403
  Forbidden on mismatch.

  Fix 3b — A2A auth + unguessable task IDs: `a2aRoutes` accepts an optional `auth.verify`
  callback that guards the `POST /` JSON-RPC endpoint (the agent-card discovery endpoint stays
  public). Task and message IDs now use `crypto.randomUUID()` instead of guessable
  `Date.now()`-based strings.

  All changes are backward-compatible: new fields are optional/nullable, auth is opt-in.

- 3a605b5: Retrospective security/correctness/performance hardening across the stack:

  - **Session safety:** `Session.open` now binds a session to its `agentId` (opening another agent's session throws), and turn-level event appends that conflict (e.g. a concurrent writer) yield a terminal `result{subtype:"error"}` instead of throwing out of the agent generator.
  - **Prompt-context integrity:** untrusted text (memory block label/value, recall snippets, skill name/description) is escaped when assembled into the `<memory>`/`<recall>`/`<skills>` system-prompt regions, and memory block labels are charset-validated at the tool boundary — preventing delimiter/structure injection.
  - **Scope isolation:** the `memories` re-index delete is now scope-filtered, and `VectorPort.delete` gained a required `scopeKey` argument (implemented across LanceDB/pgvector/Qdrant/Pinecone + fakes) so a duplicated id can't be deleted cross-tenant.
  - **Vector scores unified:** all adapters now report cosine similarity (exact match ≈ 1.0); a conformance case pins this.
  - **Consolidator:** model-supplied `confidence` is clamped to `[0,1]` (also in the `graph_assert` tool); facts rejected by the temporal-order guard are surfaced in a new `ConsolidationResult.rejected` bucket instead of being silently dropped.
  - **Performance:** single store read in `getAlwaysInContext`, targeted `StorePort.getBlock(scope, label)` lookup for block edits, a new `idx_facts_scope_active` index for currently-valid-fact queries, cached session events (no double `readEvents` per turn), and precomputed skill search tokens.

- 3a605b5: Self-editing memory blocks (Tier-1): the agent edits its own always-in-context blocks during reasoning via `memory_append` / `memory_replace` / `memory_rewrite` / `memory_archive` tools. Every mutation is recorded in a `block_history` audit trail (new SQLite migration v3 + `StorePort.getBlockHistory`). Guardrails: per-block `limit` and `readOnly` enforcement and compare-and-swap (CAS) on `version` for `replace`/`rewrite`; `append` stays conflict-free. Block metadata lives in the memory-layer config (`blocks: { label: { description, limit, readOnly } }`); `LiteMemory`/`FullMemory` now implement `EditableMemoryPort` via a shared `BlockEditor`. Drop-in unchanged: the editable methods are additive and the no-memory loop path is byte-for-byte identical.
- 3a605b5: Add `StorePort.listSessions` and `StorePort.listBlocks` read methods for studio/admin UIs. All store adapters (InMemoryStore, SqliteStore, LibsqlStore, PostgresStore) implement both methods with newest-first ordering and agentId/limit filtering on `listSessions`. Add conformance cases to `storeConformanceCases` covering newest-first ordering, agentId filter, limit cap, and scope-isolation.

  Introduce `@eidentic/studio` — a Hono-based agent management API for local dev. `createStudioApi` mounts session listing, event traces, block read/write (with CAS conflict → 409), fact graph query, memory search, and skills list/approve. `createStudio` combines these with the existing run API from `@eidentic/server`.

- 3a605b5: Temporal knowledge graph (Tier-4, §6.6): facts are timestamped, invalidatable edges `(subject, predicate, object)`. New `GraphPort` (`assertFact`/`queryFacts`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v4 `facts` table). A contradicting assertion for the same `(subject, predicate)` invalidates the prior fact by setting its `validUntil` — superseded, never deleted — enabling point-in-time ("what was believed at time T") queries. `Memory` gains an optional `graph?: GraphPort`: it delegates `assertFact`/`queryFacts` and folds matching currently-valid facts into recall as a basic entity signal (RRF-fused alongside lexical/semantic). `@eidentic/core` exposes `graph_query` (read-only) and `graph_assert` (destructive) tools to the agent whenever the memory exposes a graph. Drop-in unchanged: graph is opt-in and the no-graph loop/registry path is byte-for-byte identical. Deferred to a later release: sleep-time consolidation agent, episodic→semantic distillation, a normalized `entities` table with entity resolution, and advanced entity-signal fusion.

### Patch Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

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
