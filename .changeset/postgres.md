---
"@eidentic/postgres": minor
---

New package `@eidentic/postgres`: Postgres-backed `StorePort + GraphPort + DurablePort` adapter for server/scale deployments. Uses an injected-client pattern (`PgClient` interface satisfied by both `pg.Pool` and `@electric-sql/pglite`) so it is CI-testable without a running Postgres. Full-text search via `tsvector` generated columns + GIN index + `ts_rank` (`searchMemory`). Temporal knowledge graph, durable checkpoints, idempotency keys, and suspension decisions — all conformance-tested against the shared suite via pglite.
