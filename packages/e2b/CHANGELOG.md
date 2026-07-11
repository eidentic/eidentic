# @eidentic/e2b

## 0.2.0

### Minor Changes

- d63af81: Harden identity, tenant ownership, erasure, durable idempotency, event replay, multimodal input,
  credential storage, filesystem writes, outbound requests, runtime limits, graph concurrency, and
  error/output boundaries. Scope and idempotency keys now use versioned injective tuple formats when
  legacy delimiters are ambiguous. Store and durable adapters gain governance, credential-CAS, and
  atomic intent-claim operations; custom adapters must implement the expanded port contracts.

  Convex public handlers now deny when no authorization hook is configured. Explicitly named unsafe
  compatibility options remain for controlled migration only. See
  `docs/design/21-security-boundary-migrations.md` for migration rules and infrastructure limits.

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

## 0.1.8

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.1.6

### Patch Changes

- 37a4615: Docs fix: correct the README code examples to the real (async factory) API.

  - `@eidentic/model`: `new AIEmbedder(model, { dim })` → `await AIEmbedder.create(model)`. The
    constructor is private and the embedding dimension is probed automatically — the old example did
    not compile.
  - `@eidentic/e2b`: `E2BSandbox.create(...)` → `await E2BSandbox.create(...)` (it returns a Promise).

## 0.1.5

### Patch Changes

- Updated dependencies [2360146]
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
  - @eidentic/types@0.2.1

## 0.1.3

### Patch Changes

- cba3409: Docs fix: correct the README code examples to the real (async factory) API.

  - `@eidentic/model`: `new AIEmbedder(model, { dim })` → `await AIEmbedder.create(model)`. The
    constructor is private and the embedding dimension is probed automatically — the old example did
    not compile.
  - `@eidentic/e2b`: `E2BSandbox.create(...)` → `await E2BSandbox.create(...)` (it returns a Promise).

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

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
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
