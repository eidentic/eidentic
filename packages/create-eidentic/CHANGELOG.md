# create-eidentic

## 0.3.0

### Minor Changes

- 66dad79: Add a directory-first agent project format, safe interactive local chat, deterministic tool
  discovery, and lifecycle-aware live reload while preserving legacy `eidentic.config.*` projects.

## 0.2.1

### Patch Changes

- d63af81: Harden tenant and principal isolation, persistence and replay behavior, guarded external egress,
  file and skill boundaries, and model/cost accounting across the SDK. Correct dual-package export
  metadata so TypeScript selects matching ESM/CJS declarations, and add packed-consumer release
  checks for runtime loading and Node16/NodeNext resolution. Bound archival deduplication work with
  an explicit comparison budget and observable truncation instead of allowing 10k-entry scopes to
  perform roughly 50 million pair checks.

## 0.2.0

### Minor Changes

- 6cdc3ee: Upgrade Eidentic's AI SDK integration to AI SDK 7.

  - `@eidentic/model` now calls AI SDK 7 with `instructions`, `output`, `result.output`, `result.stream`, and `usage.inputTokenDetails.cacheReadTokens` instead of the removed/deprecated v6 surfaces.
  - `@eidentic/server` continues to emit the AI SDK UI message stream protocol against `ai@^7`.
  - AI SDK-backed packages are now ESM-only where required by the AI SDK 7 ecosystem. CommonJS consumers should migrate to ESM `import`.
  - New scaffolded projects use `ai@^7.0.2`, `@ai-sdk/react@^4.0.2`, and v7-compatible provider packages.
  - `createOllamaModel()` no longer auto-loads the old `ollama-ai-provider` package. For Ollama with AI SDK 7, install `ai-sdk-ollama@^4` and pass `ollama("model-id")` directly to `new AIModel(...)`.

## 0.1.2

### Patch Changes

- ccb1481: Harden the SDK security posture.

  Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.

## 0.1.0

### Minor Changes

- 3a605b5: Modernize the CLI tooling. `@eidentic/cli` now uses **citty** for command/arg parsing with **consola** + **picocolors** for output (`eidentic doctor`, `eidentic dev`, auto `--help`/`--version`). `create-eidentic` gains an interactive **@clack/prompts** flow (project name + model-provider selection, scaffolds the right provider dep / env var / agent import); a non-interactive path (dir arg, non-TTY) still scaffolds with defaults.
- 3a605b5: Add `nextjs-chat` template to the `create-eidentic` scaffolder.

  Running `npm create eidentic@latest` (or `npm create eidentic@latest my-app --template nextjs-chat`) now offers a second template choice alongside the existing bare Node script default.

  **What is generated:**

  - `app/api/chat/route.ts` — Eidentic agent (AIModel + LibsqlStore) wrapped with `withEidentic` from `@eidentic/nextjs`. Uses the default `"ai-sdk-ui"` protocol + `export const runtime = "nodejs"`.
  - `app/page.tsx` — minimal streaming chat UI using `useChat` from `@ai-sdk/react`. Protocol and hook are consistent: `withEidentic` default is `"ai-sdk-ui"`, `useChat` speaks that protocol natively.
  - `next.config.ts` — uses `eidenticNextConfig()` to prevent native-addon bundling errors.
  - `.env.local.example` — provider API key placeholder.
  - `package.json` — correct deps: `eidentic`, `@eidentic/nextjs`, `@eidentic/libsql`, `@ai-sdk/react`, `ai`, `next`, `react`, `react-dom`, plus the chosen provider package.
  - `tsconfig.json`, `README.md`, `.gitignore`.

  The existing default (bare Node script) template is unchanged. Template selection is exposed as an interactive wizard prompt and via a `--template` CLI flag.

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Add a convenience umbrella package and a project scaffold.

  - **`eidentic`** — a single-install umbrella that re-exports the common path (`@eidentic/core` + `@eidentic/types` + `@eidentic/model` + `@eidentic/sqlite` + `@eidentic/memory`). Beginners run `npm i eidentic ai @ai-sdk/anthropic` and get the agent loop, persistence, model adapter, and memory engine from one package. Optional adapters (vector stores, sandbox, MCP, eval, skills) stay à la carte.
  - **`create-eidentic`** — `npm create eidentic@latest <dir>` scaffolds a runnable agent project (package.json, tsconfig, a minimal `src/agent.ts` using the umbrella, `.env.example`, README). Zero runtime dependencies.

### Patch Changes

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).
