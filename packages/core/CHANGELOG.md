# @eidentic/core

## 0.2.1

### Patch Changes

- 39137dd: Docs fix: correct README code examples that did not match the real API (verified against source).

  - `@eidentic/core`: `createTool({ name, parameters, execute: ({ city }) })` →
    `createTool({ id, inputSchema, execute: ({ input }) })`.
  - `@eidentic/rag`: `ingestDocument({ source, memory, scope })` → `ingestDocument(source, { memory, scope })`
    (source first, options second); `UrlSource` is `{ url }` (no `type`); typed content `type` is
    `"markdown" | "html" | "pdf"` with a `data` field; `loadMarkdown(content)` takes the content string,
    not `{ path }`; `chunkText(text, { size, overlap })` (not `chunkSize`).
  - `@eidentic/a2a`: `a2aRoutes(agent, { card })` → `a2aRoutes({ agent, card })`; `a2aTool` options use
    `id`, not `name`.

## 0.2.0

### Minor Changes

- Add a generic audit bus: an optional `onAuditEvent` sink on `AgentConfig` that emits a single typed
  stream of security/compliance events.

  It complements `onPostToolUse`/tracing by surfacing the events a compliance log needs but that no
  existing hook emits:

  - `permission.denied` — every gate refusal (reason `"denied"` or `"gate-error"`), which `onPostToolUse`
    explicitly never sees because denied dispatches don't execute.
  - `erasure` — right-to-erasure fan-out from `Agent.eraseScope`, with per-subsystem (`store`/`vector`/`graph`)
    and `total` counts plus a `memorySkipped` flag.
  - `tool.call` — one per executed dispatch (success or error), with `scopeKey`, `sessionId`, and `durationMs`.

  The new `AuditEvent` union (in `@eidentic/types`) also defines the server-owned `auth.failure`,
  `quota.exceeded`, and `ratelimit.exceeded` variants so the HTTP server can adopt the same stream.
  The sink is best-effort: a throwing sink is swallowed and logged at `"warn"`, never affecting a run.

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

- 3a605b5: Add **composable agent strategies** (§3.6): reasoning patterns layered over the same ReAct loop, not separate loops.

  Three strategies ship:

  - **`react()`** — default passthrough. When no `strategy` is configured, behavior is byte-identical to today (the existing loop, unchanged). `react()` is the explicit form of the same default.
  - **`reflection({ critic, maxRevisions?, ground? })`** — draft → critic → revise wrapper. The base ReAct loop produces a draft; a CRITIC model (a distinct `ModelPort` — Constitution #6: intrinsic self-critique fails) evaluates it via a structured `critique` tool call (`{ satisfactory, feedback }`). If unsatisfactory, the loop re-enters with the critic's feedback in context, up to `maxRevisions` times. Optional `ground` signals (external validators, e.g. test runners, schema checkers) are called per draft and their reports fed into the critic's prompt so critique is grounded, not vibes. Robust: malformed critic output → fail-safe accept; loop always terminates. The stream emits exactly ONE terminal `result` — the accepted draft.
  - **`planAndExecute({ planner, executor?, replanEvery?, maxSteps? })`** — a PLANNER model produces a typed step list (`make_plan` tool), each step runs as a ReAct sub-run optionally on a cheaper EXECUTOR model (structurally "1× strong planner + N× cheap executor"). Replanning gate: re-plan after `replanEvery` steps or on step failure, capped by `maxSteps`. Robust against empty plans (fallback to single react run) and malformed planner output. The stream emits exactly ONE terminal `result` synthesizing all step outputs.

  **Public API:**

  ```ts
  new Agent({
    strategy: reflection({
      critic: opusModel,
      ground: [myTestRunner],
      maxRevisions: 2,
    }),
  });
  new Agent({
    strategy: planAndExecute({
      planner: opusModel,
      executor: haikuModel,
      replanEvery: 5,
    }),
  });
  new Agent({
    /* ... */
  }); // no strategy = react() default — byte-identical
  ```

  `resume()` always uses the plain react path for v1 (strategies are forward-run only).

  New exports from `@eidentic/core`: `react`, `reflection`, `planAndExecute` (functions), `AgentStrategy`, `StrategyContext`, `GroundSignal` (types).

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

- 3a605b5: §16.4 cooperative query cancellation — `aborted` result subtype producer, checkpoint-on-abort, child teardown, model `abortSignal` forwarding.

  - **`QueryOptions.signal?: AbortSignal`** (existed) is now threaded all the way through `runTurn` → `runLoop` via the new `RunTurnArgs.signal` field, closing the gap where a long model call or the loop itself would never stop on abort.
  - **Loop boundary checks:** `signal?.aborted` is tested at three points per turn — (1) top of the turn before the model call, (2) immediately after the model call + usage accounting, (3) after each tool batch. On abort the loop emits a terminal `result{subtype:"aborted"}` with the partial `usage`/`cost` accumulated so far and returns.
  - **Checkpoint-on-abort:** when `durable` mode is on, `writeCheckpoint` is called before emitting the `aborted` terminal, reusing the existing incremental rolling-hash mechanism so the aborted run is auditable and resumable.
  - **Mid-model-call abort:** `args.signal` is forwarded to the model request as `ModelRequest.signal` (new optional field on `@eidentic/types` `ModelRequest`). `AIModel.complete`/`stream` in `@eidentic/model` pass it to AI SDK v6 `generateText`/`streamText` as `abortSignal`. For the stream path, the delta iteration `break`s when `signal.aborted`; if no final response was accumulated, an `aborted` terminal is emitted rather than an error.
  - **Child teardown:** `buildSpawnTool` now accepts an optional `signal` argument (captured from `runReact`'s `opts.signal`) and threads it into each child `agent.query(input, { ..., signal })` so the entire sub-agent tree aborts cooperatively with the same semantics.
  - **No-signal path byte-identical:** all boundary checks are `signal?.aborted` which is `undefined`→falsy when no signal is supplied; zero overhead for callers that do not pass a signal.

- 3a605b5: Add **context-engine compaction** (§4.4) — progressive, token-budget-triggered compaction of the in-context message window.

  The loop previously replayed the full event log into the model window every turn, growing it unbounded (context rot + runaway cost). With `compaction` configured, `runLoop` now estimates the window before each model call (`estimateTokens`, a ~4-chars/token heuristic, §4.8) and, past `maxContextTokens`, compacts it through three progressive stages — **(1) tool-result condensing** (oversized results sliced head/tail with the pointer preserved; binary/base64 truncated-with-note, never summarized — the §4.4 anti-pattern), **(3) old-observation FIFO truncation**, and **(4) consecutive same-role coalescing** — cheapest first, stopping once under budget. The **system prefix, the recent window (`keepRecentTurns`), user turns, and all failure evidence (§4.6) are never dropped.** An `onPreCompact` hook fires first so callers can archive the full transcript. Each compaction appends a `compaction` audit event and emits a `compaction` StreamEvent (`before`/`after`/`stages`).

  Compaction operates ONLY on the in-memory window — the persisted event log is never mutated and stays the faithful audit trail; resume rebuilds from the full log and re-compacts (replayed `compaction` events are ignored). Compaction intentionally invalidates the KV cache from that point — accepted and rare (§4.3). With no `compaction` config the loop is byte-for-byte unchanged. Configure via `new Agent({ compaction: { maxContextTokens, keepRecentTurns, toolResultMaxChars }, onPreCompact })`.

  Deferred to later plans: **large-output offloading + `expand`** (§4.4 stage 2 / §4.5 filesystem-as-memory), **episodic extraction to memory** (§4.4 stage 5, ties to the Consolidator §6), the **recitation / attention anchor** (§4.6 todo re-emission), **explicit provider cache breakpoints** (§4.3), and **few-shot-collapse structural variation** (§4.6).

- 3a605b5: Feature 1 — Model fallback chain: `AgentConfig.modelFallback?: ModelPort[]` — when the primary model fails after exhausting `modelRetry`, each fallback is tried in order on both `complete()` and `stream()` paths. AbortError never triggers fallback. Streaming fallback only fires before the first delta is emitted. All models failing surfaces the last error.

  Feature 2 — Structured-output validation retry: `AgentConfig.structuredOutputRetry?: { maxAttempts: number }` — when `outputSchema` is set and the model's final answer fails schema validation, a corrective user message is appended and the model is re-called up to `maxAttempts` additional times. Default: ON with `maxAttempts: 2`. Set `{ maxAttempts: 0 }` to disable.

  Fix 3 — `Agent.eraseScope` JSDoc: removed "atomic" and documented the real best-effort fan-out semantics (store/vector/graph each attempted with per-subsystem try/catch; aggregate error thrown on partial failure; re-runnable to retry).

  Fix 4 — `StrategyContext._internalOpts` is now optional (`_internalOpts?: InternalQueryOptions`) with a "do not set" doc note, so custom strategy authors are not required to populate internal plumbing fields. Internal callers fall back to `ctx.opts` when absent.

  Fix 5 — `ToolContext.scope` now has a JSDoc explaining when it is populated (set by the registry within a scoped run; `undefined` in unit tests or bare `ToolRegistry` usage) so custom-tool authors avoid cryptic undefined errors.

- 3a605b5: Add the **Cost Governor** (§11.2) and **OpenTelemetry tracing** (§11.1).

  The cost governor enforces hard ceilings — `maxTokens`, `maxCostUsd`, `maxWallClockMs`, `maxTurns` — _before each model call_, in the critical path, outside agent code. Crossing a ceiling aborts the run with a matching termination subtype (`max_tokens` / `max_cost` / `max_wall_clock` / `max_turns`). A `softCostUsd` cap fires a one-shot `onCostThreshold` hook without aborting. Every terminal `result` event now carries a transparent `CostBreakdown` (`foreground` / `background` / `cachedInputTokens` / `usd`). Configure via `new Agent({ policy, prices, modelId, onCostThreshold })`.

  OpenTelemetry GenAI semantic-convention spans are emitted for every loop stage via a swappable `TracerPort` (`gen_ai.invoke_agent`, `gen_ai.chat`, `gen_ai.execute_tool`, plus Eidentic `memory.retrieve` / `memory.ingest`), with attributes including `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.*`, `eidentic.scope`, and `eidentic.cost_usd`. A zero-config `InMemoryTracer` ships in `@eidentic/types/testing`; point `tracer` at an OTLP adapter in production. With no `policy`/`tracer`, the loop is unchanged.

  Deferred to later plans: model routing/cascade and `prepareStep` per-step model choice, progress-gated retries, a real `@opentelemetry/*` OTLP exporter package, whole-agent-tree budget aggregation, and the eval harness (§11.3).

- 3a605b5: Durable execution substrate (§9, embedded default): crash-resume + exactly-once side effects. New `DurablePort` (`writeCheckpoint`/`lastCheckpoint` + idempotency ledger `recordIntent`/`recordCompletion`/`getIdempotency`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v6: `checkpoints` + `idempotency_keys` tables), with a shared `durableConformanceCases` suite. Tools gain an optional `idempotencyKey`; when a run is durable, `ToolRegistry.dispatch` writes an intent before a side-effecting tool runs and a completion after — on re-dispatch a key already `applied` returns the cached result WITHOUT executing (exactly-once). The loop checkpoints after each model call and tool batch via a deterministic `replayHash` (content hash over `{kind, payload}`, excluding cost/timing `meta`), and a new `Agent.resume(sessionId)` continues an interrupted run from the persisted event log with idempotency active, so already-applied side effects (payments, emails, writes) are skipped, not re-run. Opt-in via `durable: true` (requires a store implementing `DurablePort`); the fast path (`durable` falsy) is byte-for-byte unchanged. A §18.4 crash-injection test proves a destructive tool's external counter stays at 1 across a crash-and-resume. Deferred: pluggable durable-execution adapters (§9.6), distributed sagas, fork/time-travel (§9.7), progress-gated retries + circuit breaker + backoff, human-in-the-loop durable suspension (§9.4), and cross-version workflow migration (§19).
- 3a605b5: Add `Agent.eraseScope(scope)` — GDPR right-to-erasure fan-out coordinator (§15): one call hard-deletes all of a subject's data across sessions, memory (store + FTS + in-memory metadata/ingestedAt maps), vector store, and graph. `Memory.eraseScope` now also purges in-memory `metadataStore` and `ingestedAtStore` entries via a new scope-to-ids index populated during ingest. Cross-scope isolation guaranteed (erasing user A leaves user B intact); idempotent; adapters without `eraseScope` degrade gracefully (`memorySkipped: true`).
- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: GuardrailPort for input/output content guardrails (D7). Adds `GuardrailPort` to `@eidentic/types` with `checkInput`/`checkOutput` methods that can `allow`, `block` (terminate run with new `subtype: "guardrail"`), or `redact` (replace text in-place) text before it reaches the model or before it is returned to the caller. Wire via `AgentConfig.guardrails` (single port or array; off by default — zero overhead when absent). Multiple guardrails run in array order; the first `block` wins; `redact` results chain (each guardrail sees the previous guardrail's redacted output). Input guardrails fire after the user event is persisted (audit log retains the original) but before the first model call; output guardrails fire on the final assistant text before the terminal `result` event. Ships with `regexPiiGuardrail(opts?)` in `@eidentic/core`: a pure-JS, zero-external-dep PII detector/redactor covering emails, phone numbers (US + international), credit card numbers (grouped 13–19 digit), and US SSN/ITIN — `mode: "redact"` (default) or `"block"`, with per-direction `check` option. Enterprise deployments can implement the same `GuardrailPort` interface to wire in external content-moderation APIs (Azure Content Safety, Perspective API, etc.).
- 3a605b5: Human-in-the-loop durable suspension (§5.7 / §9.4). A tool can `await ctx.suspend({ reason, present })` to pause a run for human input/approval: the run persists and consumes NO compute while waiting, yields a terminal `subtype: "suspended"` result carrying the request + callId, and later `agent.resume(sessionId, { decision })` records the decision and continues — the suspended tool re-runs and `ctx.suspend` returns the injected `{ approved, data? }`, so the tool's real side effect runs EXACTLY ONCE behind that gate. Built on the Plan 9a durable substrate: new `DurablePort.recordDecision`/`getDecision` (keyed by `(sessionId, callId)`) implemented by `InMemoryStore` + `SqliteStore` (new migration v7 `suspension_decisions`), covered by `durableConformanceCases`. The loop appends a `"suspension"` audit event (ignored on replay, like `compaction`) and folds it into the rolling checkpoint hash; `ctx.suspend` requires durable execution (clear error otherwise), and a suspending tool produces no tool_result (the `SuspendSignal` is propagated to the loop, never swallowed into a tool error). Complements the Plan 10 permission "ask" gate. Deferred: cryptographic/passkey approval UX (§10.5), a hosted approval queue/notification system, multi-party approvals, and timeout/auto-deny policies.
- 3a605b5: Lazy tool discovery (§5.4): context-cost control for large toolsets.

  - **`search_tools(query, { topK? })`** — a read-only, deterministic keyword scorer (reuses `@eidentic/types` `tokenize` over each tool's name+description) returning the top-k tool **signatures** (name + one-line description only, never the input schema). Surfaces any registered tool, including not-yet-loaded ones.
  - **`load_tool(name)`** — loads a tool's full schema into the manifest for the rest of the run. Idempotent; loading an unknown/unavailable tool returns a tool-error; loading an eager-core tool is a no-op success.
  - **Threshold-based activation** via `AgentConfig.lazyTools?: boolean | { threshold?; eager?; topK? }`. Below the threshold (default 20), the per-turn manifest is **byte-identical** to today's full schema set. Above it, the model initially sees only the eager atomic core plus the two discovery meta-tools, and discovers the rest on demand.
  - **Derived, resume-deterministic state:** the loaded-set is a pure function of the event log (prior successful `load_tool` results) plus config — it is never written as a new event kind, so durable resume reconstructs the identical manifest and the replay hash is unchanged.
  - Discovery is a **context optimization, not a capability gate**: the registry remains the dispatch source of truth (an unloaded tool the model calls still dispatches), and statically-denied tools never surface in `search_tools` or any manifest.

  Deferred: embedding-scored tool search (keyword-only for v1; `search_tools` can later accept an injected embedder), persistent learned tool-affinity, automatic eviction of loaded tools under a token budget (append-only for v1), and MCP-server-side dynamic registration.

- 3a605b5: Add pluggable `LoggerPort` with silent-default `envLogger` gated by `DEBUG=eidentic:*` and secret redaction.

  **`@eidentic/types`** — new `logging.ts` exports `LogLevel`, `LogFields`, `LoggerPort`.

  **`@eidentic/core`** — new `logger.ts` exports:

  - `NoopLogger` — all-no-op, `enabled()` always false. Silent default when `DEBUG` is unset and no logger injected.
  - `envLogger()` — reads `process.env.DEBUG` once at construction; debug/info emitted only for matching namespace globs (e.g. `eidentic:*`, `eidentic:loop,eidentic:tool`); warn/error always print to stderr regardless. Safe for edge runtimes (guards `typeof process`).
  - `redactFields(fields)` — masks field values whose key matches `/key|token|secret|password|authorization|bearer|api[_-]?key|credential/i`, or whose string value starts with `sk-` or `Bearer `.
  - `AgentConfig.logger?: LoggerPort` — when unset, defaults to `envLogger()` (silent unless `DEBUG` is set).
  - Debug logs emitted at: `eidentic:loop` (model call, result subtype+usage, abort), `eidentic:tool` (dispatch, result ok/error, durable-skip), `eidentic:permission` (allow/deny + reason), `eidentic:cost` (preflight abort, USD-ceiling misconfiguration warn), `eidentic:memory` (retrieve hits count).
  - Two existing `console.warn` calls (keyless destructive tool under durable in `tool.ts`, maxCostUsd without prices in `loop.ts`) are now routed through the injected logger — warn still prints to stderr by default, preserving existing behavior.

  Prod usage: inject pino/datadog at `info+`; OTel still covers tracing.

- 3a605b5: Add `@eidentic/memory` (lite): a drop-in `MemoryPort` (`LiteMemory`) with always-in-context blocks + cross-session lexical/BM25 recall (SQLite FTS5 / in-memory), RRF-fused. The agent loop optionally takes a `MemoryPort` to inject blocks + recalled snippets and ingest conversation text. `StorePort` gains `indexMemory`/`searchMemory`.
- 3a605b5: Agent zero-config ergonomics: `query()`/`resume()` now lazily run `store.migrate()` on first
  use (memoized), so callers no longer have to remember to migrate the store. When a `memory` is
  configured but a query is made without `userId`, a one-time warning is logged (cross-session
  memory is userId-scoped, so omitting it silently disables persistence). `modelId` already
  defaults to `model.modelId`.
- 3a605b5: Add **multi-agent** support (§8): the single coordination primitive `spawn_agent` (agent-as-tool, MapReduce shape).

  Configure a parent with `new Agent({ subAgents: { name: { agent, description, outputSchema? } }, maxDepth?, policy })`. Per query the parent receives one synthesized `spawn_agent` tool whose `agent` enum lists the registered sub-agents. Calling it runs the chosen sub-agent's own `Agent.query` in a **fresh, isolated context window** — only the invocation `input` crosses the boundary, never the parent's instructions or history (§8.3). An optional `outputSchema` validates the child's final text into typed structured data (the child's text is `JSON.parse`d and Zod-validated; parse/validate failures return a clear tool error).

  Isolation and depth are enforced **via schema, not runtime checks** (§8.3): `spawn_agent` is present only when `subAgents` is non-empty AND the current spawn depth is below `maxDepth` (default 1), so a sub-agent at the depth limit structurally cannot spawn sub-sub-agents — the model never sees the tool.

  Cost is governed across the **whole tree** under one budget (§8.6): every sub-agent's usage/USD folds into a shared accumulator; the cost-governor preflight (Plan 9b) weighs tree spend against `policy.maxCostUsd`/`maxTokens` and aborts the whole tree when exceeded, and `spawn_agent` refuses to launch a sub-agent that would exceed budget. The parent's terminal `CostBreakdown` gains a transparent `children?: Usage` field summing all delegated work.

  Shared-scope memory blocks (`{kind:"shared"}`, CAS) from prior plans are reused for supervisor/worker coordination — no new abstraction. There is no separate "network" construct (§8.7): orchestration richness comes from composition.

  Deferred to later plans: a dedicated 100+ fan-out pipeline/workflow construct, the full loop-strategy library (reflection / plan-execute, §3.6), tag-based worker pools, and deep hierarchical-team auto-orchestration.

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

- 3a605b5: Add Ollama (local/offline) model support and multimodal image input.

  **Feature 1 — Ollama helper (`@eidentic/model`)**

  `createOllamaModel(modelId, opts?)` returns a Vercel AI SDK `LanguageModel` backed by a locally-running [Ollama](https://ollama.com) instance. No API key required — works fully offline.

  ```ts
  import { AIModel, createOllamaModel } from "@eidentic/model";

  const model = new AIModel(createOllamaModel("llama3.2"));
  // or with a custom server URL:
  const model2 = new AIModel(
    createOllamaModel("mistral", { baseURL: "http://192.168.1.10:11434/api" }),
  );
  ```

  `ollama-ai-provider` is an **optional peer dependency** — install it separately when you need local inference:

  ```sh
  npm install ollama-ai-provider
  # or
  pnpm add ollama-ai-provider
  ```

  **Feature 2 — Multimodal image input (`@eidentic/types`, `@eidentic/model`, `@eidentic/core`)**

  Added an `"image"` variant to `ContentBlock` (input-only / vision):

  ```ts
  import { textBlock, imageBlock } from "@eidentic/types";

  // base64 data:
  imageBlock({ data: "<base64>", mediaType: "image/jpeg" });
  // or URL:
  imageBlock({ url: "https://example.com/photo.jpg" });
  ```

  `Agent.query` now accepts `ContentBlock[]` in addition to `string`:

  ```ts
  for await (const ev of agent.query(
    [textBlock("What is in this image?"), imageBlock({ url: "https://..." })],
    { sessionId: "s1" },
  )) { ... }
  ```

  Image blocks are forwarded to vision-capable models (e.g. `llava`, `claude-3-5-sonnet`, `gpt-4o`) as AI SDK `ImagePart` objects. `query(string)` is unchanged — fully backward-compatible.

  New helpers exported from `@eidentic/types`: `imageBlock`, `isImage`, `ImageInput`, `encodeMultimodalInput`, `decodeMultimodalInput`, `MULTIMODAL_INPUT_PREFIX`, `extractTextFromBlocks`.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- 3a605b5: Add opt-in prompt caching (`AgentConfig.promptCache`). When `true`, each model call marks
  the stable system-prompt prefix as cacheable via the AI SDK's provider-options mechanism —
  Anthropic receives `cacheControl: { type: "ephemeral" }` on the system message; other
  providers ignore the hint gracefully. Cache hits are observable via `Usage.cachedInputTokens`
  and the OTel `kv_cache_hit_rate` attribute. Off by default; requests are byte-identical when
  the option is absent.
- 3a605b5: Add `@eidentic/model`: a `ModelPort` adapter over Vercel AI SDK v6 (non-streaming) that runs the agent loop against real Anthropic/OpenAI/Google models, plus `modelFromString("provider/model")`. Thread `toolName` through tool-result events/messages in `@eidentic/core` and `@eidentic/types` (required by AI SDK tool results).
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

- 3a605b5: Sandbox substrate (§10.3, §10.5, §10.7): run untrusted / agent-generated code off the host process.

  **`@eidentic/types`** — new `SandboxPort` (in `security.ts`): `run(code, opts?) => SandboxResult`
  (`{ stdout, stderr, exitCode, error? }`) with `SandboxRunOptions` (`language?`, `timeoutMs?`, `env?`).
  Adds an `EchoSandbox` fake + a `sandboxConformanceCases` contract to `@eidentic/types/testing`
  (trusted-dev/tests only — `EchoSandbox` does NOT isolate).

  **`@eidentic/core`** — new `NoneSandbox`: the secure default. `run()` refuses every call ("no sandbox
  configured: refusing to execute untrusted code …") — returns an error `SandboxResult` by default,
  or throws with `new NoneSandbox({ throwOnRun: true })`. This makes "no sandbox ⇒ no untrusted exec"
  (§10.7) real.

  **`@eidentic/e2b`** (new) — `E2BSandbox implements SandboxPort` over E2B Firecracker microVMs via an
  injected structural `E2BLike` client. CI conformance runs against a faithful in-memory fake; a gated
  live test (`EIDENTIC_TEST_E2B_API_KEY`) hits the real `@e2b/code-interpreter` (devDependency + optional
  peerDependency; only runtime dep is `@eidentic/types`).

  Deferred (not in this release): microsandbox/libkrun adapter, egress allowlisting, the executable-skill
  kind + test-gate (Plan 12b), and any portable OS-level sandbox (Landlock/Seatbelt — §10.5 says there is
  none).

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

- 3a605b5: Security foundations (§10/§20): deny-by-default permission policy and `SecretsPort` credential isolation.

  **Permissions (`@eidentic/types` + `@eidentic/core`):**

  - `PermissionPolicy` (deny/plan/allow/ask modes + glob lists) is evaluated in two layers: _schema layer_ (`filterToolsForSchema`) removes statically-denied tools before the model ever sees them, and _dispatch gate_ (`evaluatePermission` + `ToolRegistry.resolvePermission`) blocks any call that slips through at execution time — the tool body never runs.
  - `PermissionMode`: `"default"` (allow all), `"plan"` (deny non-read-only), `"ask"` (dynamic resolver), `"bypass"` (unconditional allow), `"acceptEdits"`.
  - Deny globs (`deny: ["delete_*"]`) win over every other rule. Plan mode denies any tool with `sideEffect !== "read-only"`.
  - `globMatch` — anchored `*` wildcard matching used throughout permission evaluation.
  - `Agent` accepts `permissions`, `onPreToolUse` (short-circuit hook), and `onPermissionRequest` (dynamic resolver for `ask`-mode tools). Denied results carry `meta.permissionDenied: true`.

  **Secrets (`@eidentic/types` + `@eidentic/core`):**

  - `SecretsPort` — minimal async interface (`get(ref): Promise<string | undefined>`). The model never sees secret values; they are injected into each tool's `ctx.secrets` at dispatch time only (§10.3).
  - `EnvSecrets` (`@eidentic/core`) — `SecretsPort` backed by `process.env`.
  - `MapSecrets` (`@eidentic/types/testing`) — in-memory `SecretsPort` backed by a plain record; for tests and offline demos.
  - `ToolContext` (`ctx`) is injected into every tool `execute` call and carries `ctx.secrets`, `ctx.scope`, and `ctx.signal`. Existing tools that ignore `ctx` are unaffected (the argument is optional).
  - `Agent` accepts `secrets: SecretsPort`; it is forwarded into the `ToolRegistry` and from there into each dispatch — the value is never serialised into the prompt, messages, or tool schemas.

  **Deferred:** E2B/microsandbox `SandboxPort` (executable-skill code execution) is deferred to the executable-skills plan.

- 3a605b5: Self-editing memory blocks (Tier-1): the agent edits its own always-in-context blocks during reasoning via `memory_append` / `memory_replace` / `memory_rewrite` / `memory_archive` tools. Every mutation is recorded in a `block_history` audit trail (new SQLite migration v3 + `StorePort.getBlockHistory`). Guardrails: per-block `limit` and `readOnly` enforcement and compare-and-swap (CAS) on `version` for `replace`/`rewrite`; `append` stays conflict-free. Block metadata lives in the memory-layer config (`blocks: { label: { description, limit, readOnly } }`); `LiteMemory`/`FullMemory` now implement `EditableMemoryPort` via a shared `BlockEditor`. Drop-in unchanged: the editable methods are additive and the no-memory loop path is byte-for-byte identical.
- 3a605b5: Skill System substrate (§7, v1): the durable foundation for reusable, discoverable skills. New drop-in `SkillPort` (`catalog`/`search`/`use`/`recordOutcome`) in `@eidentic/types`, mirroring `MemoryPort` so `@eidentic/core` depends only on `@eidentic/types`. New `@eidentic/skills` package (runtime-dep = only `@eidentic/types`) ships `parseSkillMd` — a dependency-free, agentskills.io-compatible `SKILL.md` frontmatter parser (`name`, multi-line `description`, inline `allowed-tools`) — and `SkillSet`, an in-memory + directory-backed implementation with 3-tier progressive disclosure (Tier-1 catalog, Tier-2 body on `skill_use`, Tier-3 per-skill `.memory.md`), description-scored search, and a `SkillProvenance` record (source + sha256 content hash + author). `@eidentic/core` exposes read-only `skill_search`/`skill_use` tools and injects a deterministic `<skills>` catalog block into the system prompt whenever an `Agent` is given `skills`. Drop-in unchanged: skills are opt-in and the no-skills loop/registry/prompt path is byte-for-byte identical. Explicitly deferred (off-by-default research bets, §7.7/§0-C12): the self-evolution loop and external optimizer integration, sandboxed executable-skill code execution (§10), signing/verification enforcement, `allowed-tools` capability enforcement (recorded, not enforced in v1), human-gated mutation, skill merge/prune consolidation, and registry import.
- 3a605b5: Token streaming: `ModelPort.stream()` (optional), `stream.delta` events from the agent loop, and `AIModel.stream()` over AI SDK v6 `streamText`. The loop prefers streaming when the model supports it and falls back to `complete()` otherwise.
- 3a605b5: Structured / schema-constrained output (D2): get a typed, validated object out of an agent.

  Pass `agent.query(input, { outputSchema })` a Zod schema (same convention as `createTool`'s `inputSchema`). The agent still runs its full multi-turn tool loop — only the **final** (tool-less) turn is constrained to the schema. The parsed, validated value is surfaced on the terminal `result` event as `result.object` (the raw text answer stays on `result.output`). If the model's structured answer fails validation, the run terminates with `subtype: "error"` describing the mismatch. Fully backward-compatible: omitting `outputSchema` leaves `query()` byte-identical.

  - **`@eidentic/types`**: `ModelRequest.outputSchema?` (JSON Schema over the port boundary) + `ModelResponse.object?`; the terminal `result` `StreamEvent` gains an optional `object?`.
  - **`@eidentic/model`**: `AIModel` forwards the schema to AI SDK v6 `generateText`/`streamText` via `experimental_output: Output.object(...)` (sets a JSON `responseFormat`) and returns the parsed object on `ModelResponse.object`.
  - **`@eidentic/core`**: `QueryOptions.outputSchema?` (Zod); the loop forwards the JSON Schema each turn and validates the final object against the source schema. Validation is authoritative (the JSON Schema is only a provider hint); when the port did not pre-parse, core parses the final text as JSON.

  Note (v1): structured output composes with the default ReAct loop; reasoning strategies and `resume()` do not thread `outputSchema` yet.

- 3a605b5: Structured output (`outputSchema`, D2) now works with reasoning **strategies** and **`resume()`** — closing the v1 limitation where it only applied to the default ReAct path.

  - **Strategies + `outputSchema`**: when a `strategy` is set and `query({ outputSchema })` is given, the schema constrains ONLY the strategy's FINAL answer. Intermediate react sub-runs run UNCONSTRAINED (reflection's draft/critique passes; planAndExecute's per-step runs), so they can still call tools and emit free text. After the strategy produces its accepted free-text answer, ONE final schema-constrained react sub-run renders it as the typed object, surfaced as `result.object` on the single terminal event. The `react()` passthrough strategy applies the schema to its single (final) run, as before.
  - **`resume({ outputSchema })`**: `resume()` now accepts an `outputSchema` and threads it into the resumed run's react path, so a resumed run also yields `result.object`. Resuming an already-terminated session validates the stored final text against the schema and attaches the parsed object (a mismatch terminates with `subtype: "error"`).

  Fully backward-compatible: omitting `outputSchema` leaves both the strategy and resume paths byte-identical.

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

- 3a605b5: Add `Agent.skillCatalog()` accessor to expose the agent's prompt-skill catalog (from `config.skills`). Update the Studio `/api/agents/:id/skills` endpoint to return a unified array combining prompt skills (`type: "prompt"`) from the SkillSet catalog with executable bank skills (`type: "executable"`, `quarantined` flag). The Skills tab in the Studio UI now renders both types with a type badge, description, and an Approve button only for quarantined executable skills.
- 3a605b5: Fix studio Sessions/Trace view always showing "unknown" for every event; surface real model id in session.init.

  **Studio fix**: `SessionsView` was reading `event.type`/`event.content`/`event.output` — the stream-event shape — but the events endpoint returns `StoredEvent` objects (`{ id, sessionId, seq, kind, schemaVersion, payload, meta?, createdAt }`). Updated the component (and the local `StoredEvent` type in `api.ts`) to read `event.kind` for the label and `event.payload`/`event.meta` for per-kind summaries (user string, assistant text/tool_use blocks, tool_result toolName+output, other kinds as JSON snippet). `seq` is now shown in the row header.

  **ModelId flow**: `ModelPort` gains an optional `modelId?: string` field. `AIModel` sets `this.modelId` from the wrapped AI SDK `LanguageModel.modelId` (available when a static model is passed; undefined for resolver-based construction). `Agent` now resolves `config.modelId ?? config.model.modelId` for the `modelId` arg passed to `runTurn`/`resumeTurn`, so `session.init.model` carries the real provider model id (e.g. `"claude-sonnet-4-5"`) with zero config. When neither is set, behavior is byte-identical to before (`""`).

- 3a605b5: Temporal knowledge graph (Tier-4, §6.6): facts are timestamped, invalidatable edges `(subject, predicate, object)`. New `GraphPort` (`assertFact`/`queryFacts`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v4 `facts` table). A contradicting assertion for the same `(subject, predicate)` invalidates the prior fact by setting its `validUntil` — superseded, never deleted — enabling point-in-time ("what was believed at time T") queries. `Memory` gains an optional `graph?: GraphPort`: it delegates `assertFact`/`queryFacts` and folds matching currently-valid facts into recall as a basic entity signal (RRF-fused alongside lexical/semantic). `@eidentic/core` exposes `graph_query` (read-only) and `graph_assert` (destructive) tools to the agent whenever the memory exposes a graph. Drop-in unchanged: graph is opt-in and the no-graph loop/registry path is byte-for-byte identical. Deferred to a later release: sleep-time consolidation agent, episodic→semantic distillation, a normalized `entities` table with entity resolution, and advanced entity-signal fusion.
- 3a605b5: Add `topicGuardrail` (LLM-judge scope enforcement) and `AgentConfig.greeting` (static opening message).

  **`topicGuardrail`** — new factory in `@eidentic/core` that returns a `GuardrailPort` whose `checkInput` uses a provided `ModelPort` to classify whether the user's input is within a declared scope, blocking off-topic requests before the main model is called. Accepts `model` (cheap classifier), `description` (what the agent IS allowed to help with), `blockMessage` (custom block reason), and `allowOnUncertain` (default `false` → fail-safe block on ambiguous/error). The classification prompt is minimal (system + user, no tools) and parses ALLOW/BLOCK case-insensitively. Defense-in-depth: complements system-prompt scoping with an independent LLM check on the raw, unprocessed input.

  **`AgentConfig.greeting`** — optional static string shown to the user before the first turn. Never sent to the model, never persisted as an event, costs no tokens. Exposed via `agent.greeting` getter and included in the `session.init` stream event payload as `greeting` so front-ends can render it immediately as an initial assistant bubble. The `StreamEvent["session.init"]` type in `@eidentic/types` gains an optional `greeting?: string` field (backward-compatible — absent when unset).

### Patch Changes

- 3a605b5: Close three access-control gaps found in security review.

  **Finding #1 (Critical) — IDOR on `/query`:** The `/query` route now performs the same `checkOwnership` check as `/resume` and `/events` before opening an SSE stream, preventing a caller from forwarding another tenant's `sessionId` to read or write into their session. Defense-in-depth: `Session.open` in `@eidentic/core` now also rejects opens where the caller's `userId`/`orgId` does not match the stored session owner, covering NextJS, A2A, and MCP entry points that bypass the HTTP server.

  **Finding #4 (High) — Quota reservation leak:** `quota.check()` on `/query` and `/resume` is now called _after_ body validation and agent resolution, so malformed-JSON `400` and unknown-agent `404` responses no longer consume an in-flight reservation slot. `InMemoryQuota` gains a `reservationMaxAgeMs` option (default 5 min) and a background sweep that automatically releases reservations that were never settled, preventing permanent capacity exhaustion from crashes or missed `release()` calls.

  **Finding #8 (Medium) — `withEidentic` body/identity:** `withEidentic` now rejects requests whose `Content-Length` exceeds `maxBodyBytes` (default 1 MB) with HTTP 413 before parsing the body. A new `identify(req)` option lets callers derive `userId`/`orgId` server-side from the authenticated session; the returned values override any client-supplied identity. JSDoc emphatically notes that `withEidentic` performs no authentication and that identity must come from the app's session, not the request body.

- 3a605b5: Internal refactor: deduplicate `canonicalJson` — move the single canonical implementation to `@eidentic/types` and remove the 6 copy-pasted copies in `core` and `skills`.

  The function was previously copy-pasted into `packages/core/src/tool.ts`, `packages/core/src/agent.ts`, `packages/core/src/replay-hash.ts`, `packages/core/src/loop.ts` (nested inside `chainHash`), `packages/skills/src/sign.ts`, and `packages/skills/src/executable.ts`. All 6 copies were confirmed byte-for-byte identical in output. The shared implementation lives in `packages/types/src/canonical-json.ts` and is re-exported from the `@eidentic/types` barrel.

  No behavior change — hashes, signatures, and idempotency keys are unaffected.

- 3a605b5: Seven performance and correctness fixes in the core agent loop (audit remediations):

  **Fix 1 — O(n²) → O(1) loaded-tool scan:** The lazy-discovery `buildManifest()` previously called `loadedToolNames(session.events(), …)` at the top of every turn, re-scanning the full event log. Now maintains an incremental `Set<string>` seeded once at loop start and updated in O(1) when a `load_tool` result is processed. Behavior is identical.

  **Fix 2 — maxRecallTokens cap:** `buildInitialMessages` now applies a configurable token budget to the `<recall>` block. Snippets (highest-ranked first) are included until the running estimate would exceed `maxRecallTokens` (default 2000, configurable via `RunTurnArgs.maxRecallTokens`). At least one snippet is always included. This prevents unlimited token growth from large recall sets.

  **Fix 3 — Newline injection in `<recall>` via `metadata.source`:** The `esc()` helper now strips ASCII control characters (including newlines and carriage returns) before escaping angle brackets. A `source` containing `\n- [source: forged]` can no longer inject a fake recall line.

  **Fix 4 — `modelRetry: { maxAttempts: 0 }` safety:** Clamped `maxAttempts` to `Math.max(1, retry.maxAttempts)` so `maxAttempts: 0` performs exactly one guarded (abort-checked) attempt instead of falling through to an unguarded `model.complete()` call.

  **Fix 5 — Resume terminal fast-path drops child cost:** Both the early no-events path and the already-terminated session fast-path in `resumeTurn` now pass `args.budget` to `breakdownFor()`, so child USD from subagent runs is correctly included in the resumed cost breakdown.

  **Fix 6 — `resumeTurn` delta-seeded hash:** When `args.durable` is set, `resumeTurn` now seeds the rolling hash from the last checkpoint's stored hash and only chains events with `seq >= checkpoint.seq`. Falls back to full rehash when no checkpoint exists. The resulting hash is mathematically identical to the full rehash (integrity preserved).

  **Fix 7 — Guardrail regex recompiled per call:** `containsPii` and `redactPii` in `guardrails.ts` previously called `new RegExp(…)` on every invocation. Now use module-level compiled regexes: non-global for `containsPii` (stateless `test()`), and global `/g` for `redactPii` (`String.replace()` resets `lastIndex` before each call). Behavior is identical.

- 3a605b5: Security hardening — 4 core findings (findings #3, #6, #7, #9):

  - **#3 (High)** — `resumeTurn` now re-runs input guardrails on the last user event before passing messages to the model, mirroring `runTurn`. PII/secret/off-topic text that was redacted on the first turn no longer leaks to the model on HITL or crash-resume paths.
  - **#6 (Medium)** — `topicGuardrail` wraps user text in `<user_input>` delimiters so the classifier treats it as data, not instructions. Response parsing now uses an exact first-token match before falling back to substring includes; a reply containing both ALLOW and BLOCK is treated as uncertain (→ block unless `allowOnUncertain`). Added JSDoc best-effort caveat.
  - **#7 (Medium)** — When the session-prefixed idempotency key is absent, `ToolRegistry` falls back to reading the bare `toolKey` (pre-prefix compatibility) before deciding to re-execute. New entries are always written with the prefixed key. Prevents previously-settled destructive tools from re-executing after an upgrade.
  - **#9 (Medium)** — `redactValue` in `logger.ts` now carries a `WeakSet` cycle guard and a depth cap (20) to prevent unbounded recursion on cyclic objects. `VALUE_SECRET_RE` broadened to cover JWTs (`eyJ…`), AWS access key IDs (`AKIA…`), Slack tokens (`xox[baprs]-`), and GitHub tokens (`ghp_`/`gho_`).

- 3a605b5: Replace `node:crypto` SHA-256 with the Web Crypto API (`globalThis.crypto.subtle.digest`) so `@eidentic/core` works zero-config on Cloudflare Workers, Deno, Bun, and browsers — no `nodejs_compat` flag required.

  All five call sites (`replay-hash.ts`, `tool.ts`, `loop.ts`, `agent.ts`, `skill-tools.ts`) now use a shared `sha256Hex` helper. The SHA-256 hex output is byte-identical, so existing event-replay hashes and checkpoint values continue to match.

  The `ToolDef.idempotencyKey` and `Tool.idempotencyKey` types are widened from `(input) => string` to `(input) => string | Promise<string>` — existing sync implementations remain valid.

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

- 3a605b5: §13 Hono REST+SSE agent server — `@eidentic/server` + `AuthPort` in `@eidentic/types`.

  - **`AuthPort`** (new in `@eidentic/types`): framework-agnostic auth interface with `AuthRequest` / `AuthPrincipal` types. Returned `null` → server responds 401.
  - **`@eidentic/server`** (new package): Hono 4.x app exposing Eidentic agents as a service.
    - `createServer(opts)` — builds the Hono router; accepts `Record<string, Agent>` or an `AgentResolver` function.
    - `GET /health` — liveness probe (no auth).
    - `POST /v1/agents/:agentId/query` — SSE-streamed run via `streamSSE`; wires `c.req.raw.signal` into `agent.query` (§16.4 request-abort cancellation); auto-generates `sessionId` when absent. Body capped at 512 KB.
    - `POST /v1/agents/:agentId/resume` — SSE-streamed resume (HITL / durable continuation). Body capped at 512 KB. `signal` now threaded into `Agent.resume` so a client disconnect aborts the underlying run.
    - `GET /v1/agents/:agentId/sessions/:sessionId/events` — JSON audit log via `store.readEvents`. **Opt-in only** (`exposeEvents: true`); returns 404 when omitted (secure-by-default). v1 limitation: no per-principal session ownership check — do not expose to untrusted multi-tenant callers without an ownership layer.
    - `NoAuth` — always-allow single-tenant adapter (default).
    - `ApiKeyAuth(keys)` — reads `Authorization: Bearer <key>` or `x-api-key`, maps to `AuthPrincipal`; principal's `userId` flows into `agent.query` scope.
    - `serveNode(app, opts?)` — optional thin wrapper over `@hono/node-server` (dynamic import; actionable error if the dep is absent).
  - **`@eidentic/core`** (patch): `Agent.store` public getter (mirrors `Agent.sandbox`); `Agent.resume` accepts `signal?: AbortSignal` threaded into the resume loop for cooperative cancellation on client disconnect.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
