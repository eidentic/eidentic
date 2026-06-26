# @eidentic/studio

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
  - @eidentic/server@0.4.0
  - @eidentic/core@0.3.1

## 0.1.9

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1
  - @eidentic/model@0.2.5
  - @eidentic/server@0.3.2
  - @eidentic/workflow@0.2.1

## 0.1.8

### Patch Changes

- ccb1481: Harden the SDK security posture.

  Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.

- Updated dependencies [37a4615]
- Updated dependencies [ccb1481]
- Updated dependencies [37a4615]
  - @eidentic/model@0.2.4
  - @eidentic/server@0.3.1
  - @eidentic/core@0.3.0

## 0.1.7

### Patch Changes

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

- Updated dependencies [2360146]
  - @eidentic/core@0.3.0
  - @eidentic/server@0.3.0
  - @eidentic/types@0.3.0
  - @eidentic/workflow@0.2.0
  - @eidentic/model@0.2.3

## 0.1.6

### Patch Changes

- Updated dependencies [44e2ca7]
  - @eidentic/server@0.2.3

## 0.1.5

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/core@0.2.2
  - @eidentic/model@0.2.2
  - @eidentic/server@0.2.2
  - @eidentic/types@0.2.1
  - @eidentic/workflow@0.1.4

## 0.1.4

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1
  - @eidentic/server@0.2.1
  - @eidentic/workflow@0.1.3

## 0.1.3

### Patch Changes

- Updated dependencies [cba3409]
  - @eidentic/model@0.2.1
  - @eidentic/core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [bb46351]
- Updated dependencies [de07ecc]
  - @eidentic/server@0.2.0
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0
  - @eidentic/model@0.2.0
  - @eidentic/workflow@0.1.2

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/model@0.1.1
  - @eidentic/server@0.1.1
  - @eidentic/types@0.1.1
  - @eidentic/workflow@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

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

- 3a605b5: Add `StorePort.listSessions` and `StorePort.listBlocks` read methods for studio/admin UIs. All store adapters (InMemoryStore, SqliteStore, LibsqlStore, PostgresStore) implement both methods with newest-first ordering and agentId/limit filtering on `listSessions`. Add conformance cases to `storeConformanceCases` covering newest-first ordering, agentId filter, limit cap, and scope-isolation.

  Introduce `@eidentic/studio` — a Hono-based agent management API for local dev. `createStudioApi` mounts session listing, event traces, block read/write (with CAS conflict → 409), fact graph query, memory search, and skills list/approve. `createStudio` combines these with the existing run API from `@eidentic/server`.

- 3a605b5: Cost/usage view: per-session totals in the Sessions list + per-agent aggregate in the detail header, USD from defaultPrices (cache-accurate), tokens exact.
- 3a605b5: Add `Agent.skillCatalog()` accessor to expose the agent's prompt-skill catalog (from `config.skills`). Update the Studio `/api/agents/:id/skills` endpoint to return a unified array combining prompt skills (`type: "prompt"`) from the SkillSet catalog with executable bank skills (`type: "executable"`, `quarantined` flag). The Skills tab in the Studio UI now renders both types with a type badge, description, and an Approve button only for quarantined executable skills.
- 3a605b5: Studio web UI (Vite+React) + `serveStudio` static serving + `eidentic studio` command (port 3535, dev tool) + `eidentic` package now provides the `eidentic` CLI bin (Next.js-style lib+CLI).
- 3a605b5: Add workflow trace visualization to Studio.

  Introduces an in-memory workflow-run registry (bounded to last 100 runs) in the Studio API and a new Workflows view in the UI.

  API (`createStudioApi` / `createStudio` now return `StudioHandle` — a Hono instance extended with `recordWorkflow`):

  - `handle.recordWorkflow(name, workflowResult)` — programmatically record a completed workflow run; derives status and timing from the trace
  - `GET /api/workflows` — list recorded runs (id, name, status, startedAt, durationMs, stepCount)
  - `GET /api/workflows/:id` — full run detail including the complete step trace and output
  - `POST /api/workflows` — HTTP ingestion endpoint (auth-gated) for recording runs from a separate process

  UI (`WorkflowsView`):

  - Sidebar nav entry "Workflows" (not agent-scoped — shows all recorded runs)
  - Left panel lists runs with name, status badge, duration, step count
  - Right panel renders the step trace as a vertical sequence indented by `StepTrace.path` depth, each row showing name, ok/error badge, duration, and error message on failure
  - Output JSON shown collapsed below the trace
  - Empty state with hint: `studio.recordWorkflow(name, await wf.run(input))`

### Patch Changes

- 3a605b5: Studio: causal trace timeline, chat-bubble mode, memory userId filter, compaction events, HITL approval card.

  **Trace / reasoning timeline** (`SessionsView`): adds a "Timeline" tab alongside the existing "Raw" events tab. The timeline renders stored events as a readable causal narrative — `user → assistant(text + tool call(args)) → tool result(output) → assistant(text) → done` — parsing `event.kind`/`event.payload` correctly (`assistant` payload = `{content: ContentBlock[]}`, `tool_result` payload = `{callId, toolName, output}`). Tool call args are collapsible; long tool outputs are expandable. Usage (in/out/cached tokens) is shown on assistant nodes. The result node surfaces turns, usage, and USD estimate.

  **Chat-bubble mode** (`RunView`): a "Chat bubbles" checkbox toggles between the existing console/log mode and a chat UI where user messages appear on the right (accent bubble), assistant messages on the left (dark bubble), and tool calls/results collapse into subtle inline rows. Compaction events appear as a centered info pill in both modes.

  **Memory userId filter** (`MemoryView`): a "Scope" card with a User ID text input lets the developer switch between agent-scope (blank) and user-scope memory. The filter applies to blocks, facts, and memory search queries. The studio server already accepted `userId` on all three endpoints; this wires the UI to pass it.

  **Compaction events in Run view**: `compaction` stream events are now surfaced as a subtle italic row (console mode) or a centered pill (bubble mode) instead of being silently dropped.

  **HITL approval card** (`RunView`): when a `result` event carries `subtype === "suspended"`, an approval card appears above the input with "Approve" and "Reject" buttons. Each calls `POST /v1/agents/:id/resume` with `{ sessionId, decision: "approve"|"reject" }`, then shows confirmation inline and dismisses the card.

- 3a605b5: Fix: the Studio Run console now keeps a STABLE session id across messages in a conversation (it previously sent no sessionId, so each message started a fresh session and the agent had no memory of prior turns). Adds a "New session" action and shows the session id; conversation history now persists across turns as expected.
- 3a605b5: Studio Run console now renders the model output token-by-token (consumes `stream.delta` events live) with a "Stream tokens" toggle and a blinking cursor; the toggle off-state shows the final message in one block. Also surfaces the terminal `subtype` on the done line.
- 3a605b5: Fix studio Sessions/Trace view always showing "unknown" for every event; surface real model id in session.init.

  **Studio fix**: `SessionsView` was reading `event.type`/`event.content`/`event.output` — the stream-event shape — but the events endpoint returns `StoredEvent` objects (`{ id, sessionId, seq, kind, schemaVersion, payload, meta?, createdAt }`). Updated the component (and the local `StoredEvent` type in `api.ts`) to read `event.kind` for the label and `event.payload`/`event.meta` for per-kind summaries (user string, assistant text/tool_use blocks, tool_result toolName+output, other kinds as JSON snippet). `seq` is now shown in the row header.

  **ModelId flow**: `ModelPort` gains an optional `modelId?: string` field. `AIModel` sets `this.modelId` from the wrapped AI SDK `LanguageModel.modelId` (available when a static model is passed; undefined for resolver-based construction). `Agent` now resolves `config.modelId ?? config.model.modelId` for the `modelId` arg passed to `runTurn`/`resumeTurn`, so `session.init.model` carries the real provider model id (e.g. `"claude-sonnet-4-5"`) with zero config. When neither is set, behavior is byte-identical to before (`""`).

- 3a605b5: Fix studio UI→API wiring bugs found by audit:

  - **B1 (blocker):** Run console now renders tool results — event name was `tool_result` (wrong) and field was `content` (wrong); fixed to `tool.result` and reads `toolName`/`output`/`isError` from the real event shape.
  - **S1:** Fact status in MemoryView was always "active" because the UI read `invalidatedAt` (absent); fixed to use `validUntil` (the real field). UI `Fact` type updated to match `@eidentic/types` (`validUntil`, `objectKind`, `confidence`).
  - **S2:** Studio UI now sends an `Authorization: Bearer` header when a `?key=` token is present in the URL (persisted to `localStorage`). The CLI `studio` command warns when auth is configured so users know to append `?key=<token>`.
  - **S3:** Aborting a streaming run no longer leaves a permanent blinking cursor — `streaming: false` is set on the in-flight entry in both `stop()` and the `finally` cleanup.
  - **N2:** A `suspended` result is no longer shown in red as an error — it renders in a neutral info style with label "suspended (awaiting approval)".
  - **N4:** Example config comment corrected: `new AIModel(anthropic(...))` (positional, not `{ model: ... }`).
  - Backend shape-pinning tests added to `packages/studio/test/studio.test.ts` to catch future event-shape regressions server-side.

- 3a605b5: Internal refactor: replace studio's private workflow-run registry with the canonical `createWorkflowRunRegistry` from `@eidentic/workflow`. Moves `@eidentic/workflow` from devDependencies to dependencies. No public API changes.
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
  - @eidentic/model@0.1.0
  - @eidentic/types@0.1.0
  - @eidentic/workflow@0.1.0
