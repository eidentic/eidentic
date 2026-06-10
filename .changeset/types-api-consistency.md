---
"@eidentic/types": minor
"@eidentic/lancedb": minor
"@eidentic/pgvector": minor
"@eidentic/qdrant": minor
"@eidentic/pinecone": minor
---

Public-API consistency fixes (audit C-P1/C-P2):

- **VectorPort**: rename `deleteScope` → `eraseScope` to match `StorePort`/`GraphPort` naming (C-P1-1)
- **BudgetError**: fix `"max_wallclock"` → `"max_wall_clock"` to match `TerminationSubtype` discriminant (C-P1-2)
- **ToolSchema**: narrow `inputSchema: unknown` → `Record<string, unknown>` (C-P1-5)
- **QuotaPort**: add optional `reservation?` param to `record` and optional `release?` method for reserve-settle lifecycle (C-P1-3)
- **PgClient**: strengthen `rows: any[]` → `rows: unknown[]` in injected client interface (C-P2)
