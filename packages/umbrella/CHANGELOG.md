# eidentic

## 1.0.1

### Patch Changes

- Updated dependencies [66dad79]
  - @eidentic/cli@0.3.0

## 1.0.0

### Major Changes

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
- Updated dependencies [d63af81]
  - @eidentic/core@1.0.0
  - @eidentic/types@1.0.0
  - @eidentic/model@0.4.0
  - @eidentic/memory@1.0.0
  - @eidentic/sqlite@0.3.0
  - @eidentic/cli@0.2.0

## 0.4.0

### Minor Changes

- 3987d37: Add the `eidentic/testing` subpath for no-key fresh-install smoke tests and adapter conformance helpers.

  Clean up the tools glob helper re-export so release builds stay quieter.

## 0.3.0

### Minor Changes

- 4cf1e3b: Add production ergonomics for multi-tenant SDK users:

  - `Agent.query()` and `Agent.resume()` now accept `principal` separately from `memoryScope`, so session ownership/permissions can differ from the memory/tool scope used by a run.
  - `Agent.query()` accepts `guardrailInput` for checking untrusted user text separately from a composed operator prompt.
  - Guardrail results can include machine-readable `code` and `severity`, and terminal guardrail events surface them through `result.details`.
  - Structured output parse/validation failures now include `result.details.errorKind`, `validationIssues`, and `rawOutput`.
  - Add `eidenticGuardrails.pii()`, `policies.*` cost-policy presets, `permissions.*` permission presets, `scopes.*` constructors, and `Agent.eraseScopes()`.

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/core@0.4.0
  - @eidentic/types@0.5.0
  - @eidentic/cli@0.1.11
  - @eidentic/memory@0.1.6
  - @eidentic/model@0.3.1
  - @eidentic/sqlite@0.2.2

## 0.2.0

### Minor Changes

- 6cdc3ee: Upgrade Eidentic's AI SDK integration to AI SDK 7.

  - `@eidentic/model` now calls AI SDK 7 with `instructions`, `output`, `result.output`, `result.stream`, and `usage.inputTokenDetails.cacheReadTokens` instead of the removed/deprecated v6 surfaces.
  - `@eidentic/server` continues to emit the AI SDK UI message stream protocol against `ai@^7`.
  - AI SDK-backed packages are now ESM-only where required by the AI SDK 7 ecosystem. CommonJS consumers should migrate to ESM `import`.
  - New scaffolded projects use `ai@^7.0.2`, `@ai-sdk/react@^4.0.2`, and v7-compatible provider packages.
  - `createOllamaModel()` no longer auto-loads the old `ollama-ai-provider` package. For Ollama with AI SDK 7, install `ai-sdk-ollama@^4` and pass `ollama("model-id")` directly to `new AIModel(...)`.

### Patch Changes

- Updated dependencies [6cdc3ee]
  - @eidentic/model@0.3.0
  - @eidentic/core@0.3.1
  - @eidentic/cli@0.1.10

## 0.1.10

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1
  - @eidentic/cli@0.1.9
  - @eidentic/memory@0.1.5
  - @eidentic/model@0.2.5
  - @eidentic/sqlite@0.2.1

## 0.1.9

### Patch Changes

- 37a4615: Docs: document the audit bus (`onAuditEvent`) in the README production-fundamentals summary.
- ccb1481: Harden the SDK security posture.

  Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.

- Updated dependencies [37a4615]
- Updated dependencies [ccb1481]
  - @eidentic/model@0.2.4
  - @eidentic/cli@0.1.8
  - @eidentic/core@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/core@0.3.0
  - @eidentic/sqlite@0.2.0
  - @eidentic/types@0.3.0
  - @eidentic/model@0.2.3
  - @eidentic/cli@0.1.7
  - @eidentic/memory@0.1.4

## 0.1.7

### Patch Changes

- @eidentic/cli@0.1.6

## 0.1.6

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/cli@0.1.5
  - @eidentic/core@0.2.2
  - @eidentic/memory@0.1.3
  - @eidentic/model@0.2.2
  - @eidentic/sqlite@0.1.3
  - @eidentic/types@0.2.1

## 0.1.5

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1
  - @eidentic/cli@0.1.4

## 0.1.4

### Patch Changes

- Updated dependencies [cba3409]
  - @eidentic/model@0.2.1
  - @eidentic/core@0.2.0
  - @eidentic/cli@0.1.3

## 0.1.3

### Patch Changes

- Docs: note that `@eidentic/convex` now supports durable execution (`DurablePort`).

## 0.1.2

### Patch Changes

- f6ead91: Docs: document the audit bus (`onAuditEvent`) in the README production-fundamentals summary.
- 2412254: Update the package description and README hero to the new positioning sentence, and fix the
  quickstart stream-event check (`ev.type === "stream.delta"` → `ev.delta.text`, terminal
  `ev.type === "result"`).
- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [bb46351]
- Updated dependencies [de07ecc]
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0
  - @eidentic/model@0.2.0
  - @eidentic/cli@0.1.2
  - @eidentic/memory@0.1.2
  - @eidentic/sqlite@0.1.2

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/cli@0.1.1
  - @eidentic/core@0.1.1
  - @eidentic/memory@0.1.1
  - @eidentic/model@0.1.1
  - @eidentic/sqlite@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Interactive `eidentic init` wizard: provider/model/API-key prompts, optional dependency install, package-manager detection (pnpm/yarn/bun/npm). Non-TTY and `--yes` flag path unchanged for scripting. New flags: `--model`, `--api-key`, `--yes`, `--install`/`--no-install`. API key is written into `.env` only after `.gitignore` is secured.
- 3a605b5: Add `eidentic init` command (scaffold Eidentic into an existing project: writes `eidentic.config.ts`, `src/agent.ts`, `.env`, `.env.example`, `.gitignore`; idempotent) and automatic `.env` loading on CLI start using Node-native `process.loadEnvFile()` — no new deps. All commands (`doctor`/`dev`/`studio`/`init`) now pick up `ANTHROPIC_API_KEY` etc. from a project-local `.env` automatically. `doctor` also reports whether a `.env` file exists in cwd (informational).
- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- 3a605b5: Bundled `defaultPrices` from LiteLLM + `cachedInputPerMTok` accurate cache pricing + opt-in `fetchLatestPrices()` + weekly CI refresh.

  - **`@eidentic/types`**: `ModelPrice.cachedInputPerMTok` — optional price per million cached input tokens (KV-cache reads). When absent, cached tokens fall back to `inputPerMTok` (back-compat). `usdFor` now prices cached and non-cached input tokens separately.

  - **`@eidentic/model`**: Ships a bundled, dated `defaultPrices: PriceTable` seeded from LiteLLM's `model_prices_and_context_window.json` (~550 entries across Anthropic, OpenAI, Gemini, DeepSeek, Mistral, xAI, Cohere). The library **never auto-fetches** at runtime — prices are static and offline-safe. Also exports `fetchLatestPrices(opts?)` (opt-in, schedule yourself), `mapLiteLLM(raw)` (pure mapping function), and `pricesUpdatedAt` (ISO date of last generation). A `gen:prices` package script + `scripts/gen-prices.ts` regenerate the table from LiteLLM.

  - **`@eidentic/cli`**: The `eidentic init` scaffold now adds `prices: defaultPrices` to the generated Agent so `cost.usd` is populated out-of-the-box.

  - **`eidentic`**: Re-exports `defaultPrices`, `pricesUpdatedAt`, `fetchLatestPrices`, `mapLiteLLM` from `@eidentic/model`.

  Token counts are always exact; USD figures are estimates — verify against your provider's current pricing page.

- 3a605b5: Studio web UI (Vite+React) + `serveStudio` static serving + `eidentic studio` command (port 3535, dev tool) + `eidentic` package now provides the `eidentic` CLI bin (Next.js-style lib+CLI).
- 3a605b5: Add a convenience umbrella package and a project scaffold.

  - **`eidentic`** — a single-install umbrella that re-exports the common path (`@eidentic/core` + `@eidentic/types` + `@eidentic/model` + `@eidentic/sqlite` + `@eidentic/memory`). Beginners run `npm i eidentic ai @ai-sdk/anthropic` and get the agent loop, persistence, model adapter, and memory engine from one package. Optional adapters (vector stores, sandbox, MCP, eval, skills) stay à la carte.
  - **`create-eidentic`** — `npm create eidentic@latest <dir>` scaffolds a runnable agent project (package.json, tsconfig, a minimal `src/agent.ts` using the umbrella, `.env.example`, README). Zero runtime dependencies.

### Patch Changes

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Fix umbrella public surface: add missing exports (guardrails, multimodal, logging, GDPR, memory recency); remove unexposed internal plumbing.
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
  - @eidentic/core@0.1.0
  - @eidentic/model@0.1.0
  - @eidentic/memory@0.1.0
  - @eidentic/types@0.1.0
  - @eidentic/cli@0.1.0
  - @eidentic/sqlite@0.1.0
