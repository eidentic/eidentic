# @eidentic/langfuse

## 0.1.4

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0

## 0.1.3

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
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

- 3a605b5: Add `@eidentic/langfuse` — Langfuse OTLP adapter for Eidentic agent traces.

  `langfuseTracer({ publicKey, secretKey })` returns a `TracerPort` that can be passed directly to `new Agent({ tracer })`. Completed spans are buffered in memory and flushed to Langfuse's OTLP/HTTP endpoint (`/api/public/otel/v1/traces`) using Basic auth — the only runtime dependency is `fetch`.

  All GenAI Semantic Convention attributes set by the Eidentic loop (`gen_ai.usage.*`, `gen_ai.request.model`, `gen_ai.tool.name`, `eidentic.cost_usd`, etc.) are forwarded as-is so Langfuse's model/token dashboards populate automatically. Spans are batched (configurable `flushAt`/`flushInterval`), and network errors are silently dropped to avoid crashing the agent. Call `tracer.shutdown()` on process exit to flush remaining spans.

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
