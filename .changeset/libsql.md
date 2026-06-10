---
"@eidentic/libsql": minor
---

New package `@eidentic/libsql`: libSQL/Turso-backed `StorePort + GraphPort + DurablePort` adapter. Async port of `@eidentic/sqlite` over `@libsql/client`, enabling edge/serverless deployments and Turso remote databases. FTS5 BM25 memory search, temporal knowledge graph, durable checkpoints and idempotency keys — all conformance-tested against the shared suite. Constructor accepts a URL string or options object with optional `authToken` for Turso Cloud; defaults to an in-memory libSQL database for zero-config dev and tests.
