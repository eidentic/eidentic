---
"@eidentic/qdrant": minor
"@eidentic/pgvector": minor
"@eidentic/lancedb": minor
"@eidentic/pinecone": minor
"@eidentic/types": patch
---

Implement `VectorPort.list` on the Qdrant, pgvector, LanceDB, and Pinecone adapters.

Previously these production vector backends did not expose `list`, so
`Memory.deduplicateArchival` and `Memory.reindexEmbeddings` silently no-op'd on them
(both treat a missing `list` as "no efficient scan available"). Each adapter now
enumerates a scope's entries — reconstructing the full `VectorEntry` including the stored
embedding — so archival dedup and embedding reindex work on real deployments:

- **pgvector** / **LanceDB**: scoped sequential scan (`SELECT … WHERE scope_key` / filtered query).
- **Qdrant**: paginated `scroll` with `with_vector` (requires the standard `@qdrant/js-client-rest` client).
- **Pinecone**: high-topK filtered query with `includeValues` (bounded to 10 000, matching the dedup safety cap).

`vectorConformanceCases` (`@eidentic/types/testing`) gains an optional `list` case that
verifies scope isolation and full payload/vector round-trip for any adapter implementing it.
