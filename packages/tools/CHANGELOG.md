# @eidentic/tools

## 0.1.9

### Patch Changes

- 3987d37: Add the `eidentic/testing` subpath for no-key fresh-install smoke tests and adapter conformance helpers.

  Clean up the tools glob helper re-export so release builds stay quieter.

## 0.1.8

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/core@0.4.0
  - @eidentic/types@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0
  - @eidentic/core@0.3.1

## 0.1.6

### Patch Changes

- ccb1481: Harden the SDK security posture.

  Dependency updates remove known vulnerable transitive ranges and CI now runs a low-threshold audit gate. Server and Studio reject accidental `NoAuth` usage in production unless explicitly opted in with `EIDENTIC_ALLOW_NO_AUTH=1`. The sealed `web_fetch` tool now resolves allowlisted hostnames before fetch and rejects private, loopback, and link-local targets to reduce DNS rebinding SSRF risk. Studio auth token handoff now prefers URL fragments so bearer tokens are not sent in HTTP requests, while preserving legacy query-token support.
  - @eidentic/core@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/core@0.3.0
  - @eidentic/types@0.3.0

## 0.1.4

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
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

- 3a605b5: New `@eidentic/tools` package: the built-in atomic tool set (§5.8) that makes Eidentic an end-to-end agent out of the box, with §5.6 sealed-endpoint security.

  - **`fileTools({ root })`** — `read_file`, `write_file`, `edit_file`, `glob`, `grep`, all confined to a workspace `root`. Path traversal, absolute paths, and symlink escape are impossible (mirrors the `@eidentic/skills` `confinedResolve` containment). read/glob/grep are read-only (parallelizable); write/edit are destructive with idempotency keys. Outputs are size-bounded.
  - **`bashTool(sandbox, opts?)`** — the sealed shell. `bash` executes ONLY via the injected `SandboxPort`, never the host process; with `NoneSandbox` it refuses (secure default, §10.7). Destructive and non-idempotent (no idempotency key — `durableUnprotected` under durable runs).
  - **`webTools({ allowlist, fetchImpl?, search? })`** — `web_fetch` is sealed and egress-allowlisted (exact or dot-boundary suffix host match; an empty allowlist denies all). The agent supplies only `url`; method/headers/body are fixed; non-http(s) schemes and off-allowlist redirects are rejected. `web_search` is included only when you bring a provider; its credentials come from `ctx.secrets`, never the model.

  Runtime deps are `@eidentic/core` + `@eidentic/types` only (Node built-ins for I/O). Deferred: lazy discovery `search_tools`/`load_tool` (§5.4), browser tools. A generic `http_request`/`exec` tool is intentionally never shipped (§5.6).

- 3a605b5: Add `resilientFetch`/`fetchJson` helpers to `@eidentic/tools` (timeout, 5xx/network retry, agent-abort-linked). Wire into Tavily/Exa/Serper/SearXNG adapters and `web_fetch`/`web_search` so every outbound HTTP call has a per-request timeout (default 10 s), automatic retry on 5xx or network errors, and is cancelled when the agent run aborts. Zero new runtime dependencies — plain `fetch` + `AbortController`. `WebSearchOptions.signal` added to `@eidentic/types` (ESM-only ky conflicts with the dual CJS build; plain fetch used instead).
- 3a605b5: Pluggable web-search: `WebSearchPort` in `@eidentic/types` + Tavily/Exa/Serper/SearXNG adapters (plain fetch, zero new runtime deps) + env auto-detect (`TAVILY_API_KEY` → `EXA_API_KEY` → `SERPER_API_KEY` → `SEARXNG_URL`) + `web_search` tool now present by default with a helpful unconfigured message (no crash, no throw); model never sees API keys (§10.3 preserved); SearXNG is the free self-host path.

### Patch Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- 3a605b5: Fix SSRF vulnerability in `@eidentic/rag` `ingestDocument({ url })`.

  **`@eidentic/tools`**: add `assertFetchableUrl(rawUrl, opts?)` — a reusable safe-URL guard that
  parses the URL, rejects non-http(s) schemes, rejects private/loopback/link-local/metadata hosts
  via the existing `isBlockedHost`, and optionally enforces a hostname allowlist via `hostAllowed`.
  Exported from the package index alongside the existing helpers.

  **`@eidentic/rag`**: `ingestDocument({ url })` now calls `assertFetchableUrl` before any network
  I/O, blocking requests to cloud-metadata endpoints (e.g. `169.254.169.254`), localhost, RFC-1918
  ranges, and IPv6-mapped private addresses. Redirects are now fetched with `redirect: "manual"` and
  the redirect target is re-validated with the same guard before following (SSRF redirect defense).
  A new optional `allowlist` field on `IngestDocumentOptions` allows callers to further restrict
  which hosts may be fetched.

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

- 3a605b5: Harden `isBlockedHost` (web_fetch SSRF guard): block IPv6-mapped/compatible IPv4
  (`::ffff:169.254.169.254`, hex `::ffff:a9fe:a9fe`, `::1.2.3.4`), IPv6 unspecified (`::`),
  and link-local `fe80::/10` — previously these forms bypassed the private-IP check and could
  reach cloud-metadata/internal hosts. Documented the residual DNS-rebinding limitation (the
  check is syntactic; use an egress proxy for untrusted-input deployments).
- 3a605b5: `webTools` — make `allowlist` optional. Previously every caller had to pass an egress
  allowlist even when they only wanted `web_search` (which doesn't use it). Now:
  omitted = no domain restriction (any public host); `[]` = explicit deny-all lockdown;
  non-empty = restrict to those hosts. The SSRF guard (`isBlockedHost`) still rejects
  private/loopback/metadata hosts in every mode.
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
