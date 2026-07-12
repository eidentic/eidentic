# @eidentic/bench

## 0.1.8

### Patch Changes

- Updated dependencies [0461c45]
  - @eidentic/types@1.1.0
  - @eidentic/memory@1.0.1

## 0.1.7

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
  - @eidentic/memory@1.0.0

## 0.1.6

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0
  - @eidentic/eval@0.1.6
  - @eidentic/memory@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/eval@0.1.5
  - @eidentic/memory@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0
  - @eidentic/eval@0.1.4
  - @eidentic/memory@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/eval@0.1.3
  - @eidentic/memory@0.1.3
  - @eidentic/types@0.2.1

## 0.1.2

### Patch Changes

- bb46351: `AIEmbedder.create` accepts a `maxRetries` option, forwarded to the AI SDK's `embed`/`embedMany`.
  The AI SDK retries transient failures (including provider rate limits / 429s) with exponential
  backoff and honours `retry-after`, so high-volume ingest against a rate-limited embedding provider
  no longer fails after the default 2 attempts. The LongMemEval harness caps over-long embedding
  inputs below the typical 8192-token embedder window.
- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0
  - @eidentic/eval@0.1.2
  - @eidentic/memory@0.1.2

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/eval@0.1.1
  - @eidentic/memory@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: feat: @eidentic/bench — runnable memory benchmark harness (§6.10)

  New package `@eidentic/bench`:

  - `recallAtK`: deterministic recall metric (no model) — fraction of gold facts found as normalized
    substrings in top-K retrieved context. Case/punctuation insensitive.
  - `runMemoryBench(makeMemory, dataset, opts)`: drives a fresh Memory per case, ingests turns, runs
    retrieval questions, aggregates into a `BenchReport` with overall + per-category recall@k.
  - `syntheticDataset`: bundled 5-case dataset covering single-session, multi-session, temporal, and
    knowledge-update categories — runs in CI without real models or large files.
  - `loadLongMemEval` / `loadLoCoMo`: gated loaders for real datasets (not bundled; user provides path).
  - CI baseline regression gate in `bench.test.ts`: semantic recall@8 on syntheticDataset must be
    > = 0.75 (measured ~0.88). Fails if the memory pipeline regresses.
  - Optional LLM judge for answer-correctness scoring (gated by `opts.judge` ModelPort).
  - `BASELINES.md`: published baseline numbers + instructions for running real datasets.

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
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/eval@0.1.0
  - @eidentic/memory@0.1.0
  - @eidentic/types@0.1.0
