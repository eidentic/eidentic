# @eidentic/react

## 0.2.0

### Minor Changes

- d63af81: Harden integration boundaries across A2A, MCP, Next.js, React, and Studio. The
  changes add fail-closed identity and authorization handling, bounded and
  cancellable A2A I/O, strict JSON request and stream validation, append-only
  regeneration safety, separate Studio run/admin authentication, credential
  redaction, and explicit Node listener hostname support while preserving drain
  semantics.

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

## 0.1.6

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.1.4

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
  - @eidentic/types@0.3.0

## 0.1.3

### Patch Changes

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

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Add async-run hooks, workflow hooks, and cost/usage surfacing to @eidentic/react.

  **Feature 1 — `useAsyncRun` / `useRunStatus` (fire-and-poll):**

  - `useAsyncRun(agentId, opts?)` → `{ start(input, { sessionId? }): Promise<{runId}>; runId; status; output; error; isPolling }`. POSTs to `POST /v1/agents/:id/runs`, then polls `GET /v1/agents/:id/runs/:runId/status` every `pollIntervalMs` (default 1500ms) until the status is terminal (`completed` / `failed` / `aborted`). Cleans up the poll on unmount and when a new run starts.
  - `useRunStatus(agentId, runId | null, opts?)` → `{ status; output; error; isPolling }`. Polls an already-existing run ID until terminal. Stops on unmount or when `runId` changes.
  - Both respect `AbortController` for cancellation; polling stops immediately on terminal or unmount.

  **Feature 2 — `useWorkflowList` / `useWorkflowRun`:**

  - `useWorkflowList(opts?)` → `{ runs; loading; error; refresh() }`. Fetches `GET /v1/workflows` (newest-first list). Supports optional `pollIntervalMs` for live refresh.
  - `useWorkflowRun(id | null, opts?)` → `{ run; trace; loading; error; refresh() }`. Fetches `GET /v1/workflows/:id` detail including `StepTrace[]`. Supports optional polling.
  - New types exported: `StepTrace`, `WorkflowRunSummary`, `WorkflowRunDetail`, `WorkflowOptions` — plain interfaces, no dependency on `@eidentic/workflow`.

  **Feature 3 — Cost/usage surfacing in the stream parser:**

  - `ParsedStreamState` gains three new fields: `usage: Usage` (cumulative, updated from assistant events; replaced by the authoritative total on the terminal `result` event), `turnUsages: TurnUsage[]` (per-turn snapshots from assistant events), and `cost: CostBreakdown | null` (populated from the terminal `result` event's `cost` field).
  - `ResultEvent` gains an optional `cost?: CostBreakdown` field.
  - `TurnUsage` interface exported: `{ turn: number; usage: Usage }`.
  - All changes are additive (backward compatible).

- 3a605b5: Complete `@eidentic/react` hook surface — zero gaps for any chat UI.

  **New capabilities in `useEidenticStream` / `useAgent`:**

  - **`resume(decision)`** — resumes a suspended (HITL) turn. POSTs `{ sessionId, decision }` to the resume endpoint and continues streaming into the same accumulated message state. `status` transitions through `"suspended" → "streaming" → "done"`. The `suspension` field (`{ callId, request }`) is always populated when `status === "suspended"` so UIs can render an approval card without any extra parsing.
  - **`regenerate()`** — re-sends the last user input as a new turn (clears messages/toolCalls/toolResults/result first).
  - **`initialMessages` opt** — seed the conversation on mount (restore from history, pre-populate).
  - **`setMessages(msgs)`** — imperative setter to replace the message list (clear, restore, or rewrite history at any time).
  - **`send(input, { body? })`** — `opts.body` merges extra fields into the POST body (per-message metadata, tracing, etc.).
  - **`onEvent(ev: StreamEvent)`** callback — raw-event escape hatch; fires for EVERY server-emitted event (tool inputs, usage/cost, compaction, suspension, `session.init`) so no information is hidden. Also exposed as `events: StreamEvent[]` on `ParsedStreamState`.
  - **`status: "suspended"`** — new status value; `StreamStatus = "idle" | "streaming" | "done" | "error" | "suspended"`.
  - **`SuspensionState`** — exported type `{ callId: string; request: SuspendRequest }`.
  - **`resumeEndpoint` opt** — override the resume URL (default: derived from query endpoint by replacing `/query` → `/resume`).
  - **`useAgent`** — auto-derives the resume endpoint as `${baseUrl}/v1/agents/:id/resume`.
  - **Parser** — `ParsedStreamState` now includes `events: StreamEvent[]` (all events) and `lastEvent: StreamEvent | null` (the triggering event for each yield). Informational events (`session.init`, `compaction`) now always yield a state update so `onEvent` consumers see them.

  **Breaking:** `session.init` now yields a state update (previously silently dropped). Any code asserting `states.length === 0` after a `session.init` only event needs updating.

  **README added** — documents two integration paths: (a) `useEidenticStream`/`useAgent` hooks for custom UIs, (b) using Vercel AI SDK `useChat` or CopilotKit directly against a Eidentic backend via `toUIMessageStreamResponse` (consumers are not locked into our hooks or our UI).

### Patch Changes

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
