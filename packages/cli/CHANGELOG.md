# @eidentic/cli

## 0.1.11

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/core@0.4.0
  - @eidentic/types@0.5.0
  - @eidentic/eval@0.1.6
  - @eidentic/server@0.4.1
  - @eidentic/studio@0.2.1

## 0.1.10

### Patch Changes

- Updated dependencies [6cdc3ee]
  - @eidentic/server@0.4.0
  - @eidentic/studio@0.2.0
  - @eidentic/core@0.3.1

## 0.1.9

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1
  - @eidentic/eval@0.1.5
  - @eidentic/server@0.3.2
  - @eidentic/studio@0.1.9

## 0.1.8

### Patch Changes

- ccb1481: Harden the SDK security posture.

  Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.

- Updated dependencies [ccb1481]
- Updated dependencies [37a4615]
  - @eidentic/server@0.3.1
  - @eidentic/studio@0.1.8
  - @eidentic/core@0.3.0

## 0.1.7

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/core@0.3.0
  - @eidentic/server@0.3.0
  - @eidentic/types@0.3.0
  - @eidentic/studio@0.1.7
  - @eidentic/eval@0.1.4

## 0.1.6

### Patch Changes

- Updated dependencies [44e2ca7]
  - @eidentic/server@0.2.3
  - @eidentic/studio@0.1.6

## 0.1.5

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
- Updated dependencies [9d3b98d]
  - @eidentic/core@0.2.2
  - @eidentic/eval@0.1.3
  - @eidentic/server@0.2.2
  - @eidentic/types@0.2.1
  - @eidentic/studio@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1
  - @eidentic/eval@0.1.2
  - @eidentic/server@0.2.1
  - @eidentic/studio@0.1.4

## 0.1.3

### Patch Changes

- @eidentic/core@0.2.0
- @eidentic/studio@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/server@0.2.0
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0
  - @eidentic/studio@0.1.2
  - @eidentic/eval@0.1.2

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/eval@0.1.1
  - @eidentic/server@0.1.1
  - @eidentic/studio@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Add `eidentic add component <name>` command to copy pre-built UI components into a project. Ships three Tailwind v4 shadcn-style components under `templates/components/`: `chat` (full chat UI on `useAgent`/`useEidenticStream`), `workflow-trace` (indented step-trace tree on `useWorkflowRun`), and `run-status` (polling status panel on `useAsyncRun`/`useRunStatus`). Installs to `components/eidentic/<name>.tsx` by default; supports `--force`, `--dir`, and `--cwd`. Lists available names on unknown input and refuses collisions without `--force`. Templates are versioned in the package, included in `files`, and typechecked at build time via a dedicated `tsconfig.templates.json`.
- 3a605b5: Add `eidentic add skill <source>` command to install skills into a project's local skills directory (`skills/<name>/`). Supports local path sources and name-based resolution via an injectable `--from` directory resolver. Validates the SKILL.md schema before installing, refuses collisions unless `--force`, copies all skill files (excluding the `.memory.md` runtime artefact), and exits non-zero with a clear message on any failure.
- 3a605b5: Interactive `eidentic init` wizard: provider/model/API-key prompts, optional dependency install, package-manager detection (pnpm/yarn/bun/npm). Non-TTY and `--yes` flag path unchanged for scripting. New flags: `--model`, `--api-key`, `--yes`, `--install`/`--no-install`. API key is written into `.env` only after `.gitignore` is secured.
- 3a605b5: Add `eidentic init` command (scaffold Eidentic into an existing project: writes `eidentic.config.ts`, `src/agent.ts`, `.env`, `.env.example`, `.gitignore`; idempotent) and automatic `.env` loading on CLI start using Node-native `process.loadEnvFile()` — no new deps. All commands (`doctor`/`dev`/`studio`/`init`) now pick up `ANTHROPIC_API_KEY` etc. from a project-local `.env` automatically. `doctor` also reports whether a `.env` file exists in cwd (informational).
- 3a605b5: Modernize the CLI tooling. `@eidentic/cli` now uses **citty** for command/arg parsing with **consola** + **picocolors** for output (`eidentic doctor`, `eidentic dev`, auto `--help`/`--version`). `create-eidentic` gains an interactive **@clack/prompts** flow (project name + model-provider selection, scaffolds the right provider dep / env var / agent import); a non-interactive path (dir arg, non-TTY) still scaffolds with defaults.
- 3a605b5: Add the `eidentic` CLI (`eidentic dev` + `eidentic doctor`) with jiti-powered TypeScript config loading (no build step). `doctor` checks Node version, model-provider env key, and config file presence. `dev` loads `eidentic.config.{ts,js,mjs}`, builds a Eidentic server, and serves it with `@hono/node-server`.
- 3a605b5: Add CI-gate support to `@eidentic/eval` and `eidentic eval` CLI command.

  **`@eidentic/eval`**

  - **`assertPassRate(report, threshold, opts?): void`** — throws `EvalThresholdError` when the
    aggregate pass rate (mean of per-scorer pass fractions from `report.aggregate`) is below
    `threshold` (0–1). The error carries `actualPassRate`, `requiredPassRate`, and `failedCases`
    (per-case pass rates for cases below threshold). Returns cleanly otherwise.
    Optional `opts.scorers` restricts the check to a named subset of scorers.
  - **`summarize(report): string`** — human-readable, CI-friendly text summary: aggregate per-scorer
    pass/mean/n, then a per-case breakdown with individual pass rates and any runner errors surfaced.
  - **`EvalThresholdError`** — typed error class (name `"EvalThresholdError"`) with machine-readable
    fields so callers can format their own output or re-throw.

  **`@eidentic/cli`**

  - **`eidentic eval <config>`** — new subcommand. Loads an eval config file (`.ts`/`.js`/`.mjs`) via
    jiti (same mechanism as `eidentic dev`), runs the eval, prints the summary, and exits 0.
    The config file must export `{ runner, dataset, scorers, samples? }`.
  - **`--ci`** flag — enables the CI gate: exits non-zero with a clear error message when the
    aggregate pass rate is below `--threshold` (default 1.0).
  - **`--threshold <n>`** (`-t`) — pass-rate threshold in [0, 1] (e.g. `--threshold 0.8` = 80 %).

  Pure helpers `computePassRate` and `evalGateCheck` are also exported from `commands.ts` for
  programmatic use and testability without process.exit.

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Bundled `defaultPrices` from LiteLLM + `cachedInputPerMTok` accurate cache pricing + opt-in `fetchLatestPrices()` + weekly CI refresh.

  - **`@eidentic/types`**: `ModelPrice.cachedInputPerMTok` — optional price per million cached input tokens (KV-cache reads). When absent, cached tokens fall back to `inputPerMTok` (back-compat). `usdFor` now prices cached and non-cached input tokens separately.

  - **`@eidentic/model`**: Ships a bundled, dated `defaultPrices: PriceTable` seeded from LiteLLM's `model_prices_and_context_window.json` (~550 entries across Anthropic, OpenAI, Gemini, DeepSeek, Mistral, xAI, Cohere). The library **never auto-fetches** at runtime — prices are static and offline-safe. Also exports `fetchLatestPrices(opts?)` (opt-in, schedule yourself), `mapLiteLLM(raw)` (pure mapping function), and `pricesUpdatedAt` (ISO date of last generation). A `gen:prices` package script + `scripts/gen-prices.ts` regenerate the table from LiteLLM.

  - **`@eidentic/cli`**: The `eidentic init` scaffold now adds `prices: defaultPrices` to the generated Agent so `cost.usd` is populated out-of-the-box.

  - **`eidentic`**: Re-exports `defaultPrices`, `pricesUpdatedAt`, `fetchLatestPrices`, `mapLiteLLM` from `@eidentic/model`.

  Token counts are always exact; USD figures are estimates — verify against your provider's current pricing page.

- 3a605b5: **Studio agent-detail view — tools, model, and instructions per agent.**

  ### `@eidentic/core`

  New public members on `Agent`:

  - `toolSchemas(): ToolSchema[]` — returns the effective tool set for a default agent-scoped turn: the configured `config.tools` plus all auto-added groups (`memory_*` when memory is editable, `graph_*` when a graph store is attached, `skill_*` when skills are configured, `spawn_agent` when sub-agents exist, lazy discovery tools when `lazyTools` is enabled). Safe to call without a live session; intended for introspection.
  - `get modelId(): string | undefined` — the model id from `config.modelId ?? config.model.modelId`.
  - `get instructions(): string` — the agent's system prompt.

  ### `@eidentic/studio`

  Backend:

  - `GET /api/agents/:id` — new detail endpoint returning `{ id, instructions, model, tools: ToolSchema[], hasMemory, hasSkills, hasGraph }`. Auth-gated like all other routes.
  - `GET /api/agents` — each summary now includes `toolCount: number`.

  UI (`packages/studio/ui`):

  - New **Tools** tab (`ToolsView`) listing each tool's name, description, and expandable input schema.
  - **Agent detail header** above tab content: agent id, model id, instructions snippet, and capability badges (tools count, memory, graph, skills).
  - Tabs reordered: Tools is the default view when an agent is selected; Agents → Tools → Sessions → Memory → Skills → Run.
  - Selecting a different agent switches back to the Tools tab automatically.

  ### `@eidentic/cli`

  The `eidentic init`-generated `eidentic.config.ts` now includes a sample `get_time` tool so a freshly scaffolded agent immediately shows a tool in the Studio UI.

- 3a605b5: Studio web UI (Vite+React) + `serveStudio` static serving + `eidentic studio` command (port 3535, dev tool) + `eidentic` package now provides the `eidentic` CLI bin (Next.js-style lib+CLI).

### Patch Changes

- 3a605b5: Fix studio UI→API wiring bugs found by audit:

  - **B1 (blocker):** Run console now renders tool results — event name was `tool_result` (wrong) and field was `content` (wrong); fixed to `tool.result` and reads `toolName`/`output`/`isError` from the real event shape.
  - **S1:** Fact status in MemoryView was always "active" because the UI read `invalidatedAt` (absent); fixed to use `validUntil` (the real field). UI `Fact` type updated to match `@eidentic/types` (`validUntil`, `objectKind`, `confidence`).
  - **S2:** Studio UI now sends an `Authorization: Bearer` header when a `?key=` token is present in the URL (persisted to `localStorage`). The CLI `studio` command warns when auth is configured so users know to append `?key=<token>`.
  - **S3:** Aborting a streaming run no longer leaves a permanent blinking cursor — `streaming: false` is set on the in-flight entry in both `stop()` and the `finally` cleanup.
  - **N2:** A `suspended` result is no longer shown in red as an error — it renders in a neutral info style with label "suspended (awaiting approval)".
  - **N4:** Example config comment corrected: `new AIModel(anthropic(...))` (positional, not `{ model: ... }`).
  - Backend shape-pinning tests added to `packages/studio/test/studio.test.ts` to catch future event-shape regressions server-side.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/server@0.1.0
  - @eidentic/core@0.1.0
  - @eidentic/eval@0.1.0
  - @eidentic/types@0.1.0
  - @eidentic/studio@0.1.0
