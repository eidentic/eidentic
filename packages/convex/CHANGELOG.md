# @eidentic/convex

## 0.8.1

### Patch Changes

- Updated dependencies [0461c45]
  - @eidentic/types@1.1.0

## 0.8.0

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

## 0.7.2

### Patch Changes

- d07429e: Accept generated Convex `ActionCtx` values directly in the component runner/store helpers and add `fromActionCtx(ctx, component)` for bridge-free component setup.

## 0.7.1

### Patch Changes

- Updated dependencies [4cf1e3b]
  - @eidentic/types@0.5.0

## 0.7.0

### Minor Changes

- 4b06c20: Add a component-first Convex adapter while preserving the existing app-functions/HTTP runner path.

  `@eidentic/convex` now exports a Convex Component config at `@eidentic/convex/convex.config.js`
  and a runtime helper surface at `@eidentic/convex/component` with `EidenticComponentStore`,
  `EidenticComponentVectorStore`, `convexActionRunner`, and generated-ref extraction helpers. Component
  tables are isolated and use singular snake_case names. The app-functions path remains source
  compatible, but also gains explicit `@eidentic/convex/app-functions/*` exports plus table-name
  factories for prefixed schemas.

  Durable idempotency records now accept optional `scopeKey`, `sessionId`, and `ownerKey` metadata.
  Eidentic core passes `sessionId` metadata for durable tool dispatch so Convex authorization hooks can
  check structured ownership fields instead of parsing opaque keys.

  Backward compatibility: existing `@eidentic/convex`, `@eidentic/convex/schema`, and
  `@eidentic/convex/server` imports keep their original behavior and default table names. The bare
  public `export * from "@eidentic/convex/server"` path remains available for trusted/single-tenant
  installs, but multi-tenant apps should use `eidenticFunctions({ authorize })` or migrate to the
  component path.

### Patch Changes

- Updated dependencies [4b06c20]
  - @eidentic/types@0.4.0

## 0.6.0

### Minor Changes

- 37a4615: Add an optional `authorize` hook to secure the Convex adapter's function handlers.

  The new `eidenticFunctions({ authorize })` factory builds all 31 store/vector functions with an
  `EidenticAuthorize` hook that runs (and is awaited) before every handler body — throw to deny the
  op, return to allow it. The hook receives the Convex `ctx` (so it can call
  `ctx.auth.getUserIdentity()`) plus `{ op, args }`, enabling authentication and `scopeKey` ownership
  checks. The functions stay public (the runtime calls them over HTTP), so authorization happens
  in-function rather than by making them internal.

  Non-breaking: the existing `export * from "@eidentic/convex/server"` / top-level exports are
  unchanged and remain unauthenticated — suitable only for trusted, single-tenant deployments. Both
  `eidenticFunctions` and the `EidenticAuthorize` type are re-exported from `@eidentic/convex`.

## 0.5.0

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
  - @eidentic/types@0.3.0

## 0.4.0

### Minor Changes

- 67ca2f6: Add an optional `authorize` hook to secure the Convex adapter's function handlers.

  The new `eidenticFunctions({ authorize })` factory builds all 31 store/vector functions with an
  `EidenticAuthorize` hook that runs (and is awaited) before every handler body — throw to deny the
  op, return to allow it. The hook receives the Convex `ctx` (so it can call
  `ctx.auth.getUserIdentity()`) plus `{ op, args }`, enabling authentication and `scopeKey` ownership
  checks. The functions stay public (the runtime calls them over HTTP), so authorization happens
  in-function rather than by making them internal.

  Non-breaking: the existing `export * from "@eidentic/convex/server"` / top-level exports are
  unchanged and remain unauthenticated — suitable only for trusted, single-tenant deployments. Both
  `eidenticFunctions` and the `EidenticAuthorize` type are re-exported from `@eidentic/convex`.

## 0.3.1

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/types@0.2.1

## 0.3.0

### Minor Changes

- `ConvexStore` now implements **`DurablePort`** in addition to `StorePort` + `GraphPort`, so durable
  execution works on Convex: checkpoint/resume, an exactly-once idempotency ledger (intent →
  completion), and human-in-the-loop suspension decisions. Three tables are added to `eidenticTables`
  (`checkpoints`, `idempotency`, `decisions`). Each operation is a single serializable Convex
  mutation, so exactly-once holds under concurrency without extra locking. Passes the full
  `durableConformanceCases` suite (11 cases) alongside the existing store + vector conformance.

## 0.2.1

### Patch Changes

- Republish fix: `0.2.0` was bootstrapped to npm with `npm publish`, which does not resolve pnpm's
  `workspace:*` protocol — so its published manifest listed `"@eidentic/types": "workspace:*"`,
  making the package uninstallable. `0.2.1` is published with `pnpm publish`, which correctly pins
  `@eidentic/types` to a real version. No code changes. (`0.2.0` is deprecated on npm.)

## 0.2.0

### Minor Changes

- 7c454e5: Add `@eidentic/convex` — a Convex-backed store adapter. `ConvexStore` implements `StorePort` +
  `GraphPort` (sessions, the append-only event log, CAS memory blocks + history, the lexical memory
  index, and the temporal knowledge graph) and `ConvexVectorStore` implements `VectorPort`. The
  agent runtime talks to Convex through an injectable runner (`ConvexHttpClient` in production,
  `convex-test` in tests); the adapter ships its tables (`eidenticTables`) and re-exportable function
  handlers so a Convex app's reactive UI can subscribe directly to agent data. Passes the full
  `storeConformanceCases` + `vectorConformanceCases` suites (39 cases). Also fixes the stale
  `StorePort` example in the `@eidentic/types` README (`putBlock` → `upsertBlock`) and documents
  validating a bring-your-own-store against the conformance suite.

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0
