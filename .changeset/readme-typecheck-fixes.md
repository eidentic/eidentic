---
"@eidentic/browser": patch
"@eidentic/cli": patch
"@eidentic/core": patch
"@eidentic/e2b": patch
"@eidentic/eval": patch
"@eidentic/lancedb": patch
"@eidentic/langfuse": patch
"@eidentic/libsql": patch
"@eidentic/memory": patch
"@eidentic/model": patch
"@eidentic/postgres": patch
"@eidentic/rag": patch
"@eidentic/server": patch
"@eidentic/sqlite": patch
"@eidentic/tools": patch
"@eidentic/transformers": patch
"@eidentic/types": patch
---

Docs: correct README code examples that drifted from the real API — surfaced by the new
`check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
`new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
