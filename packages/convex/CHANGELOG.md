# @eidentic/convex

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
