# @eidentic/libsql

## 0.3.0

### Minor Changes

- d63af81: Harden identity, tenant ownership, erasure, durable idempotency, event replay, multimodal input,
  credential storage, filesystem writes, outbound requests, runtime limits, graph concurrency, and
  error/output boundaries. Scope and idempotency keys now use versioned injective tuple formats when
  legacy delimiters are ambiguous. Store and durable adapters gain governance, credential-CAS, and
  atomic intent-claim operations; custom adapters must implement the expanded port contracts.

  Convex public handlers now deny when no authorization hook is configured. Explicitly named unsafe
  compatibility options remain for controlled migration only. See
  `docs/design/21-security-boundary-migrations.md` for migration rules and infrastructure limits.

### Patch Changes

- d63af81: Harden tenant and principal isolation, persistence and replay behavior, guarded external egress,
  file and skill boundaries, and model/cost accounting across the SDK. Correct dual-package export
  metadata so TypeScript selects matching ESM/CJS declarations, and add packed-consumer release
  checks for runtime loading and Node16/NodeNext resolution. Bound archival deduplication work with
  an explicit comparison budget and observable truncation instead of allowing 10k-entry scopes to
  perform roughly 50 million pair checks.
- Updated dependencies [d63af81]
- Updated dependencies [d63af81]
  - @eidentic/types@1.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.2.0

### Minor Changes

- 2360146: Harden tenant identity propagation and modernize the release path.

  - Session ownership now carries API-key principals through core, server, Next.js, A2A, MCP,
    workflow agent steps, and first-party durable store adapters.
  - SQLite, LibSQL, Postgres, and Convex stores persist and filter sessions by `apiKey`.
  - Output guardrails now block or redact before assistant events are persisted or ingested into memory.
  - Pinecone and Qdrant vector adapters isolate logical IDs per scope, preventing cross-scope overwrite/delete.
  - Optional Ollama support stays peer-only instead of pulling the provider into CI.
  - Studio's Vite build now explicitly targets ES2022 to match the UI TypeScript target under the updated esbuild toolchain.
  - Memory and graph mutation tools now provide scope-aware idempotency keys.
  - Skills can pass cancellation signals into executable skills and configure sandbox timeouts.
  - Workflow run registries expose `flush()` for deterministic durable write-through and crash-safety tests.
  - Release automation now uses a single checked publish script with Changesets and npm Trusted Publishing/OIDC.

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0

## 0.1.3

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
- Updated dependencies [9d3b98d]
  - @eidentic/types@0.2.1

## 0.1.2

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

- 3a605b5: Add §15 right-to-erasure: `StorePort.eraseScope` + `VectorPort.deleteScope` + `Memory.eraseScope` — scope-isolated hard-delete across all store and vector adapters; conformance-tested against InMemory, SQLite, libSQL, Postgres (pglite), LanceDB, pgvector (pglite), Qdrant (faithful fake), and Pinecone (faithful fake).
- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: New package `@eidentic/libsql`: libSQL/Turso-backed `StorePort + GraphPort + DurablePort` adapter. Async port of `@eidentic/sqlite` over `@libsql/client`, enabling edge/serverless deployments and Turso remote databases. FTS5 BM25 memory search, temporal knowledge graph, durable checkpoints and idempotency keys — all conformance-tested against the shared suite. Constructor accepts a URL string or options object with optional `authToken` for Turso Cloud; defaults to an in-memory libSQL database for zero-config dev and tests.
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

- 3a605b5: Add `StorePort.listSessions` and `StorePort.listBlocks` read methods for studio/admin UIs. All store adapters (InMemoryStore, SqliteStore, LibsqlStore, PostgresStore) implement both methods with newest-first ordering and agentId/limit filtering on `listSessions`. Add conformance cases to `storeConformanceCases` covering newest-first ordering, agentId filter, limit cap, and scope-isolation.

  Introduce `@eidentic/studio` — a Hono-based agent management API for local dev. `createStudioApi` mounts session listing, event traces, block read/write (with CAS conflict → 409), fact graph query, memory search, and skills list/approve. `createStudio` combines these with the existing run API from `@eidentic/server`.

### Patch Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Fix `@eidentic/libsql` read-modify-write races (B1): `appendBlock`, `upsertBlock` (CAS), and `assertFact` were non-atomic — a SELECT followed by a separate write with no transaction, so concurrent writers could lose data or leave duplicate valid facts. Fixed: `appendBlock` uses a single `ON CONFLICT DO UPDATE SET value = value || ?` statement (no separate read needed); `upsertBlock` CAS pushes the version predicate into the `UPDATE … WHERE version = ?` and checks `rowsAffected`; `assertFact` serializes concurrent callers via a JS-level mutex and uses `client.batch("write")` for the atomic invalidate-old + insert-new write.
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
