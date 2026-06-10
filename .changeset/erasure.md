---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/libsql": minor
"@eidentic/postgres": minor
"@eidentic/memory": minor
"@eidentic/lancedb": minor
"@eidentic/pgvector": minor
"@eidentic/qdrant": minor
"@eidentic/pinecone": minor
---

Add §15 right-to-erasure: `StorePort.eraseScope` + `VectorPort.deleteScope` + `Memory.eraseScope` — scope-isolated hard-delete across all store and vector adapters; conformance-tested against InMemory, SQLite, libSQL, Postgres (pglite), LanceDB, pgvector (pglite), Qdrant (faithful fake), and Pinecone (faithful fake).
