# @eidentic/workflow

## 0.2.4

### Patch Changes

- Updated dependencies [0461c45]
  - @eidentic/types@1.1.0
  - @eidentic/core@1.1.0

## 0.2.3

### Patch Changes

- d63af81: Fail fast on invalid workflow numeric options, clean up retry cancellation listeners after normal
  completion, and harden the file run store with owner-only permissions, random fsynced atomic
  writes, cross-process locking, and symlink-safe path validation.
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

## 0.2.2

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/core@0.4.0
  - @eidentic/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1

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
  - @eidentic/core@0.3.0
  - @eidentic/types@0.3.0

## 0.1.4

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/core@0.2.2
  - @eidentic/types@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Add two ergonomic DX layers on top of the existing functional combinator engine — all three styles share one trace engine and produce identical `StepTrace` output.

  **Layer 1 — Fluent builder** (`workflow(name)` with no body):

  ```ts
  const wf = workflow("triage")
    .step(classify) // pins In=string, Cur=string
    .branch((c) => c === "billing", billing, retry(tech, { maxAttempts: 2 }))
    .parallel({ summary: summarize, sentiment: analyze }); // Cur = { summary: string; sentiment: string }

  const { output } = await wf.run(ticket);
  ```

  `WorkflowStart.step<A,B>()` pins the input type; each subsequent builder method threads `Cur` through the type system with zero annotations. Available methods: `.step()` (named/anonymous), `.branch()`, `.parallel()`, `.map()` (only callable when `Cur` is `E[]`), `.tap()`. Terminal: `.run()`, `.asStep()`, `.build()`. The builder compiles to `chain()` internally.

  `retry`, `fallback`, and `withTimeout` wrap individual steps passed in — they are not builder methods.

  **Layer 2 — Imperative escape-hatch** (enriched `StepContext`):

  ```ts
  const wf = workflow("triage", async (ticket: string, { step, all }) => {
    const kind = await step("classify", classify, ticket);
    const handled =
      kind === "billing"
        ? await step("billing", billing, ticket)
        : await step("tech", retry(tech, { maxAttempts: 2 }), ticket);
    return all({
      summary: () => step("summary", summarize, handled),
      sentiment: () => step("sentiment", analyze, handled),
    });
  });
  ```

  `ctx.step(name, thunk)` and `ctx.step(name, step, input)` run traced units; `ctx.all(thunks)` runs concurrent thunks with a typed result object. Both delegate to the same `step()` wrapper as the declarative path.

- 3a605b5: Add `WorkflowRunRegistry` to `@eidentic/workflow` and consumer-facing workflow endpoints to `@eidentic/server`.

  `@eidentic/workflow` exports `createWorkflowRunRegistry({ limit? })` — a bounded in-memory ring-buffer (default 100 entries) that derives `status`, `startedAt`, `durationMs`, `stepCount`, and `error` from a `WorkflowResult` trace. Also exports `WorkflowRunRecord`, `WorkflowRunRegistry`, and `WorkflowRunRegistryOptions`.

  `@eidentic/server` adds:

  - `handle.recordWorkflow(name, result)` on the value returned by `createServer()` — programmatic ingestion, returns the generated record id.
  - `GET /v1/workflows` — auth-gated list of run summaries `[{ id, name, status, startedAt, durationMs, stepCount }]`, newest first.
  - `GET /v1/workflows/:id` — auth-gated full detail `{ id, name, status, startedAt, durationMs, stepCount, trace, output?, error? }`, 404 for unknown ids.

  `createServer` now returns `EidenticServer` (a `Hono & { handle: ServerHandle }` intersection) — existing `app.request(...)` usage is unaffected.

- 3a605b5: Add `@eidentic/workflow` — type-safe, composable workflow primitives for orchestrating multi-step agent pipelines.

  **Core primitives:**

  - `step(name, fn)` — names a step for tracing; emits `step.start` / `step.finish` / `step.error` events and records a `StepTrace` entry
  - `chain(a, b, ...)` — sequential pipe with typed overloads for 2–8 steps; output of each feeds the next; zero-annotation inference flows A→…→last
  - `parallel({ key: step, ... })` — runs all steps concurrently on the same input; returns a typed record of results; any rejection surfaces which keys failed
  - `branch(predicate, ifTrue, ifFalse)` — conditional routing; supports async predicates
  - `retry(inner, { maxAttempts, backoffMs?, shouldRetry? })` — retries on failure with optional backoff; AbortError is never retried
  - `fallback(primary, ...fallbacks)` — tries each step in order until one succeeds; AbortError propagates immediately
  - `withTimeout(inner, ms)` — races the step against a timeout; aborts the inner step via a linked signal when the timeout fires
  - `map(inner, { concurrency? })` — runs a step over each array element with bounded concurrency (default 4), preserving output order
  - `tap(fn)` — side-effect passthrough; returns input unchanged

  **Agent adapter:**

  - `agentStep(agent, { toInput?, fromOutput?, sessionId? })` — wraps an `Agent` as a `Step`; drains `agent.query()` to the terminal result event; a non-success terminal throws so retry/fallback can catch it; forwards the step signal

  **Workflow runner:**

  - `workflow(name, body)` — creates a named `Workflow<I,O>`; `run(input, { signal?, onEvent? })` returns `{ output, trace }`; `asStep()` exposes the workflow as a composable `Step` with path nesting

### Patch Changes

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: `chain()` now uses a single recursive variadic-tuple type signature instead of the 7 hardcoded overloads (2–8 steps). Inference flows through chains of **any length** — `chain(s1, …, sN)` infers `Step<FirstInput, LastOutput>` exactly (no `unknown` collapse, no 8-step cap; verified up to 48 steps). Step adjacency is checked at compile time: if a step's output type isn't assignable to the next step's input, it's a type error positioned at the offending argument. The runtime is unchanged (the impl already looped over all steps). Type-only and backward compatible — anything that compiled before still compiles; more now compiles with better types.
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
  - @eidentic/types@0.1.0
