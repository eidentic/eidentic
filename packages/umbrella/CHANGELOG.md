# eidentic

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
