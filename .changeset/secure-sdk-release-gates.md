---
"@eidentic/a2a": patch
"@eidentic/bench": patch
"@eidentic/better-auth": patch
"@eidentic/browser": patch
"@eidentic/cli": patch
"@eidentic/convex": patch
"@eidentic/core": patch
"create-eidentic": patch
"@eidentic/e2b": patch
"@eidentic/eval": patch
"@eidentic/lancedb": patch
"@eidentic/langfuse": patch
"@eidentic/libsql": patch
"@eidentic/mcp": patch
"@eidentic/memory": patch
"@eidentic/model": patch
"@eidentic/nextjs": patch
"@eidentic/pgvector": patch
"@eidentic/pinecone": patch
"@eidentic/postgres": patch
"@eidentic/prompts": patch
"@eidentic/qdrant": patch
"@eidentic/rag": patch
"@eidentic/react": patch
"@eidentic/server": patch
"@eidentic/skills": patch
"@eidentic/sqlite": patch
"@eidentic/studio": patch
"@eidentic/tools": patch
"@eidentic/transformers": patch
"@eidentic/types": patch
"eidentic": patch
"@eidentic/workflow": patch
---

Harden tenant and principal isolation, persistence and replay behavior, guarded external egress,
file and skill boundaries, and model/cost accounting across the SDK. Correct dual-package export
metadata so TypeScript selects matching ESM/CJS declarations, and add packed-consumer release
checks for runtime loading and Node16/NodeNext resolution. Bound archival deduplication work with
an explicit comparison budget and observable truncation instead of allowing 10k-entry scopes to
perform roughly 50 million pair checks.
