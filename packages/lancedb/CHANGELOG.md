# @eidentic/lancedb

## 0.2.3

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0

## 0.2.1

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
- Updated dependencies [9d3b98d]
  - @eidentic/types@0.2.1

## 0.2.0

### Minor Changes

- de07ecc: Implement `VectorPort.list` on the Qdrant, pgvector, LanceDB, and Pinecone adapters.

  Previously these production vector backends did not expose `list`, so
  `Memory.deduplicateArchival` and `Memory.reindexEmbeddings` silently no-op'd on them
  (both treat a missing `list` as "no efficient scan available"). Each adapter now
  enumerates a scope's entries — reconstructing the full `VectorEntry` including the stored
  embedding — so archival dedup and embedding reindex work on real deployments:

  - **pgvector** / **LanceDB**: scoped sequential scan (`SELECT … WHERE scope_key` / filtered query).
  - **Qdrant**: paginated `scroll` with `with_vector` (requires the standard `@qdrant/js-client-rest` client).
  - **Pinecone**: high-topK filtered query with `includeValues` (bounded to 10 000, matching the dedup safety cap).

  `vectorConformanceCases` (`@eidentic/types/testing`) gains an optional `list` case that
  verifies scope isolation and full payload/vector round-trip for any adapter implementing it.

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0

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

- 3a605b5: Add §15 right-to-erasure: `StorePort.eraseScope` + `VectorPort.deleteScope` + `Memory.eraseScope` — scope-isolated hard-delete across all store and vector adapters; conformance-tested against InMemory, SQLite, libSQL, Postgres (pglite), LanceDB, pgvector (pglite), Qdrant (faithful fake), and Pinecone (faithful fake).
- 3a605b5: Memory `full`: semantic (vector) recall. New `VectorPort`/`EmbeddingPort`/`RerankPort`; `@eidentic/lancedb` (embedded vector store) and `@eidentic/transformers` (local bge-small embeddings + optional mxbai rerank) adapters; `FullMemory` fuses lexical (FTS5) + vector via RRF with optional reranking. Drop-in: `FullMemory` is a `MemoryPort`, so the agent loop is unchanged.
- 3a605b5: Retrospective security/correctness/performance hardening across the stack:

  - **Session safety:** `Session.open` now binds a session to its `agentId` (opening another agent's session throws), and turn-level event appends that conflict (e.g. a concurrent writer) yield a terminal `result{subtype:"error"}` instead of throwing out of the agent generator.
  - **Prompt-context integrity:** untrusted text (memory block label/value, recall snippets, skill name/description) is escaped when assembled into the `<memory>`/`<recall>`/`<skills>` system-prompt regions, and memory block labels are charset-validated at the tool boundary — preventing delimiter/structure injection.
  - **Scope isolation:** the `memories` re-index delete is now scope-filtered, and `VectorPort.delete` gained a required `scopeKey` argument (implemented across LanceDB/pgvector/Qdrant/Pinecone + fakes) so a duplicated id can't be deleted cross-tenant.
  - **Vector scores unified:** all adapters now report cosine similarity (exact match ≈ 1.0); a conformance case pins this.
  - **Consolidator:** model-supplied `confidence` is clamped to `[0,1]` (also in the `graph_assert` tool); facts rejected by the temporal-order guard are surfaced in a new `ConsolidationResult.rejected` bucket instead of being silently dropped.
  - **Performance:** single store read in `getAlwaysInContext`, targeted `StorePort.getBlock(scope, label)` lookup for block edits, a new `idx_facts_scope_active` index for currently-valid-fact queries, cached session events (no double `readEvents` per turn), and precomputed skill search tokens.

- 3a605b5: Public-API consistency fixes (audit C-P1/C-P2):

  - **VectorPort**: rename `deleteScope` → `eraseScope` to match `StorePort`/`GraphPort` naming (C-P1-1)
  - **BudgetError**: fix `"max_wallclock"` → `"max_wall_clock"` to match `TerminationSubtype` discriminant (C-P1-2)
  - **ToolSchema**: narrow `inputSchema: unknown` → `Record<string, unknown>` (C-P1-5)
  - **QuotaPort**: add optional `reservation?` param to `record` and optional `release?` method for reserve-settle lifecycle (C-P1-3)
  - **PgClient**: strengthen `rows: any[]` → `rows: unknown[]` in injected client interface (C-P2)

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
