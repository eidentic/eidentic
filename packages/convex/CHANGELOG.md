# @eidentic/convex

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
