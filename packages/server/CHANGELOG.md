# @eidentic/server

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/types@0.1.1
  - @eidentic/workflow@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Add `toUIMessageStreamResponse` and `toUIMessageStream` to `@eidentic/server`.

  Converts a Eidentic `AsyncIterable<StreamEvent>` into a Vercel AI SDK v6 UI
  message-stream `Response`, enabling direct `useChat` (and CopilotKit) support
  in Next.js App Router routes:

  ```ts
  // app/api/chat/route.ts
  import { toUIMessageStreamResponse } from "@eidentic/server";

  export async function POST(req: Request) {
    const { messages, sessionId } = await req.json();
    return toUIMessageStreamResponse(
      myAgent.query(messages.at(-1)?.content ?? "", { sessionId })
    );
  }
  ```

  **Mapping:**

  - `stream.delta` → `text-delta` (streaming token)
  - `assistant` text blocks → `text-start` + `text-delta` + `text-end`
  - `assistant` tool_use blocks → `tool-input-available`
  - `tool.result` (success) → `tool-output-available`
  - `tool.result` (error) → `tool-output-error`
  - `result` → `finish` with finishReason (`success`→`stop`, `max_tokens`→`length`, `error`→`error`, others→`other`)
  - `session.init` / `compaction` → silently ignored

  Adds `ai` as a runtime dependency of `@eidentic/server`.

- 3a605b5: Add async fire-and-poll run API (`POST /v1/agents/:id/runs` + `GET /v1/agents/:id/runs/:runId/status`). Clients can start a run, disconnect immediately, and poll for completion or replay results via the existing SSE Last-Event-ID path. Auth, rate-limit, and quota checks run before the run is accepted; ownership is enforced on the status endpoint. Also removes ~14 `as unknown as` quota reservation casts by introducing a local `QuotaWithReservation` type alias (depends on `@eidentic/types` `QuotaPort` gaining the `reservation?` param).
- 3a605b5: Add `BatchRunner` — bounded-concurrency offline batch processing for agent inputs.

  `BatchRunner` accepts an array of `BatchItem` inputs and processes them through an
  agent with a configurable concurrency cap (default 4). Features:

  - **Error isolation**: a failing item is captured as `{ status: "error" }` and the
    batch continues — one bad item never aborts the whole run.
  - **Aggregate usage/cost**: reuses `Usage` + `CostBreakdown` from `@eidentic/types`;
    sums `inputTokens`, `outputTokens`, and USD across all successful items.
  - **AbortSignal cancellation**: once the signal fires, no further items are dispatched;
    in-flight items receive the signal; `aggregate.cancelled` is set to `true`.
  - **Progress callback**: `onProgress(item)` is invoked once per completed item
    (success or error) for streaming partial results to a UI or disk.
  - **Provider-native batch seam**: a `BatchBackend` strategy interface allows a future
    Anthropic Message Batches or OpenAI Batch API adapter to slot in without changing
    the public `BatchRunner` API. v1 uses `agent.query()` directly with bounded
    parallelism (provider-native batch deferred — AI SDK v6 does not expose the
    provider REST batch APIs cleanly).

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

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

- 3a605b5: §20.4 per-tenant cumulative quotas ($/tokens/runs) — 402 on hard cap + soft-cap warning header.

  - **`QuotaUsage`, `QuotaLimits`, `QuotaCheck`, `QuotaPort`** added to `@eidentic/types` ports and exported from the barrel. `QuotaPort.check(key)` returns `{ ok, warn?, reason?, usage? }`; `QuotaPort.record(key, { usd, tokens })` accumulates spend (+1 run). Hard ceilings (hardUsd / hardTokens / hardRuns) block; soft ceiling (softUsd) warns.
  - **`InMemoryQuota`** (new `@eidentic/server/src/quota.ts`): in-memory cumulative ledger. Constructor accepts uniform `QuotaLimits` or a per-key `(key) => QuotaLimits` resolver. Shares the `CostBreakdown` ledger (foreground+background+cached count via the terminal `result` event's `usage.inputTokens + outputTokens` + `cost.usd`). A `reset(key?)` helper supports tests. The key map is unbounded — fine for v1 single-process use; a store/Redis-backed ledger is appropriate for multi-process deployments.
  - **`ServerOptions.quota?: QuotaPort`** + **`ServerOptions.quotaKey?`**: when set, every `POST /v1/agents/:id/query` and `/resume` checks the ledger AFTER auth + rate-limit and BEFORE agent resolution or SSE stream open. Hard-cap exceeded → HTTP **402 Payment Required** with JSON body `{ error: "quota_exceeded", reason, usage }` (no stream). Soft-cap crossed → `X-Eidentic-Quota-Warning: soft-limit` response header (stream continues normally). After the SSE loop ends, the terminal `result` event's `usage` + `cost` is recorded via `quota.record(key, { usd, tokens })`. When absent, the check is skipped — the hot path is byte-identical to the no-quota behaviour.
  - Quota key derivation shares the same default as `rateLimitKey`: `principal.apiKey ?? principal.userId ?? principal.orgId ?? "anonymous"`.

  Deferred (out of scope for v1): storage quotas, monthly-window reset/approval flow, model-downgrade-on-soft, persistent/Redis ledger, background-spend attribution beyond what the terminal result reports.

- 3a605b5: §20.3 tenant token-bucket rate limiting — per-request server-enforced 429 + Retry-After.

  - **`RateLimitResult` + `RateLimiterPort`** added to `@eidentic/types` ports and exported from the barrel. `RateLimiterPort.acquire(key, cost?)` returns `{ ok, retryAfterMs?, remaining? }`.
  - **`InMemoryTokenBucketLimiter`** (new `@eidentic/server/src/rate-limit.ts`): classic token bucket with injectable `now` for deterministic testing. Per-key lazy bucket creation; refills on each `acquire` call based on elapsed time; `remaining` tracks available tokens. The key map is unbounded — fine for v1 single-process use; a Redis/store-backed limiter is appropriate for multi-process deployments.
  - **`ServerOptions.rateLimiter?: RateLimiterPort`** + **`ServerOptions.rateLimitKey?`**: when set, every `POST /v1/agents/:id/query` and `/resume` checks the limiter AFTER auth resolves and BEFORE agent resolution or SSE stream open. Throttled requests receive HTTP 429 with `Retry-After: <ceil(ms/1000)>` and JSON body `{ error: "rate_limited", retryAfterMs }`. When absent, the check is skipped — the hot path is byte-identical to pre-rate-limit behaviour.

  Deferred (out of scope for v1): per-model/per-tool-call limiting, fleet-wide Redis coordination, dynamic `Retry-After` header parsing from upstream provider 429s, per-agent concurrency caps.

- 3a605b5: Add in-process `Scheduler` to `@eidentic/server` for background agent runs.

  Registers tasks with an interval (`{ kind: "interval", everyMs }`) or cron expression (`{ kind: "cron", expression, tz? }`) and fires a `RunCallback` on each trigger. Uses `cron-parser` for next-run computation.

  Key semantics:

  - **Overlap skip**: if a task's previous invocation is still in-flight when the next tick fires, the tick is silently skipped (at-most-once-per-interval, not catch-up).
  - **Error isolation**: each task's callback is wrapped in a detached promise chain; errors are caught and logged via the injected `LoggerPort` without affecting the scheduler or other tasks.
  - **Injectable clock + timer**: `ClockPort` and `TimerPort` are dependency-injected seams for deterministic testing without real timers.
  - **Lifecycle**: `start()` / `stop()` (both idempotent), `add(task)` / `remove(id)`.

  This is an **in-process** scheduler only — state is memory-resident and not coordinated across instances. Durable/multi-instance scheduling (survive restart, leader election) is a planned follow-up.

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

- 3a605b5: SSE stream resumability: every streamed event now carries an `id:` field whose value is the corresponding `StoredEvent.seq`. Clients that disconnect mid-run can reconnect by sending the standard `Last-Event-ID` header — the server replays all durable events with seq > N and, for completed sessions, synthesizes a final `result` event without restarting the agent. The same ownership gate enforced on initial connections applies to reconnects. The default path (no `Last-Event-ID`) is byte-compatible with prior behaviour.
- 3a605b5: Add `WorkflowRunRegistry` to `@eidentic/workflow` and consumer-facing workflow endpoints to `@eidentic/server`.

  `@eidentic/workflow` exports `createWorkflowRunRegistry({ limit? })` — a bounded in-memory ring-buffer (default 100 entries) that derives `status`, `startedAt`, `durationMs`, `stepCount`, and `error` from a `WorkflowResult` trace. Also exports `WorkflowRunRecord`, `WorkflowRunRegistry`, and `WorkflowRunRegistryOptions`.

  `@eidentic/server` adds:

  - `handle.recordWorkflow(name, result)` on the value returned by `createServer()` — programmatic ingestion, returns the generated record id.
  - `GET /v1/workflows` — auth-gated list of run summaries `[{ id, name, status, startedAt, durationMs, stepCount }]`, newest first.
  - `GET /v1/workflows/:id` — auth-gated full detail `{ id, name, status, startedAt, durationMs, stepCount, trace, output?, error? }`, 404 for unknown ids.

  `createServer` now returns `EidenticServer` (a `Hono & { handle: ServerHandle }` intersection) — existing `app.request(...)` usage is unaffected.

### Patch Changes

- 3a605b5: Close three access-control gaps found in security review.

  **Finding #1 (Critical) — IDOR on `/query`:** The `/query` route now performs the same `checkOwnership` check as `/resume` and `/events` before opening an SSE stream, preventing a caller from forwarding another tenant's `sessionId` to read or write into their session. Defense-in-depth: `Session.open` in `@eidentic/core` now also rejects opens where the caller's `userId`/`orgId` does not match the stored session owner, covering NextJS, A2A, and MCP entry points that bypass the HTTP server.

  **Finding #4 (High) — Quota reservation leak:** `quota.check()` on `/query` and `/resume` is now called _after_ body validation and agent resolution, so malformed-JSON `400` and unknown-agent `404` responses no longer consume an in-flight reservation slot. `InMemoryQuota` gains a `reservationMaxAgeMs` option (default 5 min) and a background sweep that automatically releases reservations that were never settled, preventing permanent capacity exhaustion from crashes or missed `release()` calls.

  **Finding #8 (Medium) — `withEidentic` body/identity:** `withEidentic` now rejects requests whose `Content-Length` exceeds `maxBodyBytes` (default 1 MB) with HTTP 413 before parsing the body. A new `identify(req)` option lets callers derive `userId`/`orgId` server-side from the authenticated session; the returned values override any client-supplied identity. JSDoc emphatically notes that `withEidentic` performs no authentication and that identity must come from the app's session, not the request body.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

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

- 3a605b5: Fix three server-level resource leaks.

  - **Rate-limiter memory leak** (`InMemoryTokenBucketLimiter`): the `buckets` Map
    previously grew one entry per unique tenant key forever. An opportunistic sweep
    now evicts entries whose `lastRefillMs` is older than twice the full-refill window
    (`capacity / refillPerSec * 2000 ms`) — a threshold at which the bucket is
    guaranteed to be at full capacity, making eviction semantically lossless. The sweep
    runs at most once per full-refill window; no background timer is used. A `bucketCount`
    accessor is exposed for testing.

  - **Double `readEvents` on SSE reconnect**: when a client reconnected via
    `Last-Event-ID` on an in-progress run (fall-through from the replay path), both
    the `/query` and `/resume` handlers were calling `agent.store.readEvents(sessionId)`
    twice — once in the replay block and again in the live-streaming path for `baseSeq`
    computation. The second call is now eliminated by caching the first result and
    reusing it in the live path.

  - **`BatchRunner` large-batch scalability**: `BatchRunOptions.collectResults` (default
    `true`) lets callers opt out of in-memory result accumulation for very large batches.
    When `false`, `BatchResult.results` is empty while `aggregate` totals remain accurate;
    results should be drained via the `onProgress` callback instead.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
  - @eidentic/workflow@0.1.0
