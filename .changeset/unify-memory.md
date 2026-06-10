---
"@eidentic/memory": minor
---

Unify `LiteMemory` and `FullMemory` into a single `Memory` class. `vector` and `embedder` are now optional: omit them for zero-infra lexical recall, provide both for RRF-fused lexical+semantic recall, and add a `reranker` for cross-encoder rerank. "lite" vs "full" is now just whether you wire a vector store — one class with graceful degradation (design §6.12). Construction validates that `vector`/`embedder` are supplied together and that `reranker` is only used with them. `LiteMemory`/`FullMemory` are removed (pre-1.0); migrate to `new Memory({ store })` or `new Memory({ store, vector, embedder })`.
