---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/libsql": minor
"@eidentic/postgres": minor
"@eidentic/studio": minor
---

Add `StorePort.listSessions` and `StorePort.listBlocks` read methods for studio/admin UIs. All store adapters (InMemoryStore, SqliteStore, LibsqlStore, PostgresStore) implement both methods with newest-first ordering and agentId/limit filtering on `listSessions`. Add conformance cases to `storeConformanceCases` covering newest-first ordering, agentId filter, limit cap, and scope-isolation.

Introduce `@eidentic/studio` — a Hono-based agent management API for local dev. `createStudioApi` mounts session listing, event traces, block read/write (with CAS conflict → 409), fact graph query, memory search, and skills list/approve. `createStudio` combines these with the existing run API from `@eidentic/server`.
