# @eidentic/nextjs

## 0.3.1

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/core@0.4.0
  - @eidentic/types@0.5.0
  - @eidentic/server@0.4.1

## 0.3.0

### Minor Changes

- 6cdc3ee: Upgrade Eidentic's AI SDK integration to AI SDK 7.

  - `@eidentic/model` now calls AI SDK 7 with `instructions`, `output`, `result.output`, `result.stream`, and `usage.inputTokenDetails.cacheReadTokens` instead of the removed/deprecated v6 surfaces.
  - `@eidentic/server` continues to emit the AI SDK UI message stream protocol against `ai@^7`.
  - AI SDK-backed packages are now ESM-only where required by the AI SDK 7 ecosystem. CommonJS consumers should migrate to ESM `import`.
  - New scaffolded projects use `ai@^7.0.2`, `@ai-sdk/react@^4.0.2`, and v7-compatible provider packages.
  - `createOllamaModel()` no longer auto-loads the old `ollama-ai-provider` package. For Ollama with AI SDK 7, install `ai-sdk-ollama@^4` and pass `ollama("model-id")` directly to `new AIModel(...)`.

### Patch Changes

- Updated dependencies [6cdc3ee]
  - @eidentic/server@0.4.0
  - @eidentic/core@0.3.1

## 0.2.2

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1
  - @eidentic/server@0.3.2

## 0.2.1

### Patch Changes

- 37a4615: `withEidentic` now accepts a Vercel `useChat` `{ messages: [...] }` request body, so the route works
  with `useChat` out of the box on BOTH sides (it already emitted the UI-message stream `useChat`
  consumes; it now also reads the request `useChat` sends). Previously it only read a plain
  `input`/`message` string, so `useChat`'s default POST required a client-side `prepareSendMessagesRequest`
  bridge. The newest user message's text is extracted (both the AI SDK v5+ `parts` array and the legacy
  `content` string are supported); the agent reloads prior turns from the store via `sessionId`, so the
  full history isn't replayed.
- Updated dependencies [ccb1481]
- Updated dependencies [37a4615]
  - @eidentic/server@0.3.1
  - @eidentic/core@0.3.0

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
  - @eidentic/server@0.3.0
  - @eidentic/types@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [44e2ca7]
  - @eidentic/server@0.2.3

## 0.1.5

### Patch Changes

- 4970e0e: `withEidentic` now accepts a Vercel `useChat` `{ messages: [...] }` request body, so the route works
  with `useChat` out of the box on BOTH sides (it already emitted the UI-message stream `useChat`
  consumes; it now also reads the request `useChat` sends). Previously it only read a plain
  `input`/`message` string, so `useChat`'s default POST required a client-side `prepareSendMessagesRequest`
  bridge. The newest user message's text is extracted (both the AI SDK v5+ `parts` array and the legacy
  `content` string are supported); the agent reloads prior turns from the store via `sessionId`, so the
  full history isn't replayed.

## 0.1.4

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/core@0.2.2
  - @eidentic/server@0.2.2
  - @eidentic/types@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1
  - @eidentic/server@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/server@0.2.0
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/server@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: `@eidentic/nextjs` — Next.js App Router integration package.

  Removes the two biggest Next.js dogfooding footguns:

  - **`withEidentic(agent, opts?)`** — creates a typed Next.js App Router `POST` route handler. Reads `{ input | message, sessionId, userId }` from the JSON body, calls `agent.query` with `req.signal` for cooperative cancellation, and streams the response. Supports `opts.protocol`:
    - `"ai-sdk-ui"` (default) — delegates to `@eidentic/server`'s `toUIMessageStreamResponse` so a `useChat` frontend works out of the box.
    - `"ndjson"` — raw `StreamEvent` NDJSON stream for `@eidentic/react`'s `useEidenticStream`.
  - **`eidenticNextConfig(userConfig?)`** — merges `serverExternalPackages: ["better-sqlite3"]` into your `next.config` so the native addon is never bundled by Webpack.

  Usage:

  ```ts
  // app/api/chat/route.ts
  import { withEidentic } from "@eidentic/nextjs";
  import { myAgent } from "@/lib/agent";

  export const runtime = "nodejs"; // required
  export const POST = withEidentic(myAgent);
  ```

  ```ts
  // next.config.ts
  import { eidenticNextConfig } from "@eidentic/nextjs";
  export default eidenticNextConfig({
    /* ...existing config */
  });
  ```

### Patch Changes

- 3a605b5: Close three access-control gaps found in security review.

  **Finding #1 (Critical) — IDOR on `/query`:** The `/query` route now performs the same `checkOwnership` check as `/resume` and `/events` before opening an SSE stream, preventing a caller from forwarding another tenant's `sessionId` to read or write into their session. Defense-in-depth: `Session.open` in `@eidentic/core` now also rejects opens where the caller's `userId`/`orgId` does not match the stored session owner, covering NextJS, A2A, and MCP entry points that bypass the HTTP server.

  **Finding #4 (High) — Quota reservation leak:** `quota.check()` on `/query` and `/resume` is now called _after_ body validation and agent resolution, so malformed-JSON `400` and unknown-agent `404` responses no longer consume an in-flight reservation slot. `InMemoryQuota` gains a `reservationMaxAgeMs` option (default 5 min) and a background sweep that automatically releases reservations that were never settled, preventing permanent capacity exhaustion from crashes or missed `release()` calls.

  **Finding #8 (Medium) — `withEidentic` body/identity:** `withEidentic` now rejects requests whose `Content-Length` exceeds `maxBodyBytes` (default 1 MB) with HTTP 413 before parsing the body. A new `identify(req)` option lets callers derive `userId`/`orgId` server-side from the authenticated session; the returned values override any client-supplied identity. JSDoc emphatically notes that `withEidentic` performs no authentication and that identity must come from the app's session, not the request body.

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
  - @eidentic/types@0.1.0
