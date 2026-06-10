---
"@eidentic/qdrant": minor
---

New `@eidentic/qdrant` adapter: a drop-in `VectorPort` for Qdrant. Accepts an injected `QdrantClient`-shaped handle (it opens no connection itself), ensures the collection exists with cosine distance, scopes recall by a `scope_key` payload filter, and returns Qdrant's cosine similarity directly as the score (higher = better, ranking-consistent with LanceDB/pgvector). Conformance runs in CI against a faithful in-memory fake; a gated live test (`EIDENTIC_TEST_QDRANT_URL`) covers a real server. Depends only on `@eidentic/types` at runtime; `@qdrant/js-client-rest` is an optional peer dependency. Note: real Qdrant requires UUID/integer point ids.
