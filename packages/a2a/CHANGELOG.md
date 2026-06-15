# @eidentic/a2a

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

- 39137dd: Docs fix: correct README code examples that did not match the real API (verified against source).

  - `@eidentic/core`: `createTool({ name, parameters, execute: ({ city }) })` →
    `createTool({ id, inputSchema, execute: ({ input }) })`.
  - `@eidentic/rag`: `ingestDocument({ source, memory, scope })` → `ingestDocument(source, { memory, scope })`
    (source first, options second); `UrlSource` is `{ url }` (no `type`); typed content `type` is
    `"markdown" | "html" | "pdf"` with a `data` field; `loadMarkdown(content)` takes the content string,
    not `{ path }`; `chunkText(text, { size, overlap })` (not `chunkSize`).
  - `@eidentic/a2a`: `a2aRoutes(agent, { card })` → `a2aRoutes({ agent, card })`; `a2aTool` options use
    `id`, not `name`.

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

- 3a605b5: Add `@eidentic/a2a` — Agent-to-Agent (A2A) interop package.

  **Server side** (`a2aRoutes`): expose any `AgentLike` (or a real `@eidentic/core` `Agent`) as an A2A-compatible Hono endpoint — `GET /.well-known/agent-card.json` returns the discovery card; `POST /` handles JSON-RPC `message/send` (run the agent, return a completed `Task` with a text part) and `tasks/get` (retrieve stored task by id). Unknown method → -32601; malformed input → -32600/-32602/-32700.

  **Client side** (`a2aTool`, `httpA2ATransport`, `fetchAgentCard`): consume any remote A2A agent as a first-class Eidentic `Tool`. `a2aTool(transport)` wraps an `A2ATransport` (structural interface — network-free in tests), calls `message/send`, extracts the reply text from the returned Task history. Error responses and transport throws surface as `{ error }` results (never throw out of execute). `httpA2ATransport(baseUrl)` provides a real fetch-based transport for production; `fetchAgentCard(baseUrl)` fetches the well-known agent card.

  **Structural transport** keeps CI network-free: `A2ATransport` is a plain interface (`send(method, params): Promise<unknown>`) so tests inject an in-memory fake without importing `@a2a-js/sdk`.

  **Deferred**: `message/stream` + SSE streaming, push notifications, OAuth.

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

### Patch Changes

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
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/core@0.1.0
  - @eidentic/types@0.1.0
