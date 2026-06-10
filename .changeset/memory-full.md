---
"@eidentic/types": minor
"@eidentic/memory": minor
"@eidentic/lancedb": minor
"@eidentic/transformers": minor
---

Memory `full`: semantic (vector) recall. New `VectorPort`/`EmbeddingPort`/`RerankPort`; `@eidentic/lancedb` (embedded vector store) and `@eidentic/transformers` (local bge-small embeddings + optional mxbai rerank) adapters; `FullMemory` fuses lexical (FTS5) + vector via RRF with optional reranking. Drop-in: `FullMemory` is a `MemoryPort`, so the agent loop is unchanged.
