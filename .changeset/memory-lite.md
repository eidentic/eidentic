---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/core": minor
"@eidentic/memory": minor
---

Add `@eidentic/memory` (lite): a drop-in `MemoryPort` (`LiteMemory`) with always-in-context blocks + cross-session lexical/BM25 recall (SQLite FTS5 / in-memory), RRF-fused. The agent loop optionally takes a `MemoryPort` to inject blocks + recalled snippets and ingest conversation text. `StorePort` gains `indexMemory`/`searchMemory`.
