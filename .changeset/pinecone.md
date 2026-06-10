---
"@eidentic/pinecone": minor
---

New `@eidentic/pinecone` adapter: a drop-in `VectorPort` for Pinecone. Accepts an injected pre-created `Index` handle (it opens no connection and does not create indexes — the user provisions the index with the matching dimension and cosine metric). Scopes recall by a `scope_key` metadata filter and returns Pinecone's cosine similarity directly as the score (higher = better, ranking-consistent with LanceDB/pgvector). Conformance runs in CI against a faithful in-memory fake; a gated live test (`EIDENTIC_TEST_PINECONE_API_KEY` + `EIDENTIC_TEST_PINECONE_INDEX`) covers a real service. Depends only on `@eidentic/types` at runtime; `@pinecone-database/pinecone` is an optional peer dependency.
