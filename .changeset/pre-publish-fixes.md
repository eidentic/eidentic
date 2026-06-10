---
"@eidentic/core": minor
"eidentic": minor
"@eidentic/sqlite": patch
"@eidentic/libsql": patch
"@eidentic/postgres": patch
"@eidentic/tools": patch
"@eidentic/bench": patch
"@eidentic/a2a": patch
"@eidentic/better-auth": patch
"@eidentic/e2b": patch
"@eidentic/eval": patch
"@eidentic/lancedb": patch
"@eidentic/mcp": patch
"@eidentic/memory": patch
"@eidentic/model": patch
"@eidentic/pgvector": patch
"@eidentic/pinecone": patch
"@eidentic/qdrant": patch
"@eidentic/server": patch
"@eidentic/skills": patch
"@eidentic/transformers": patch
"@eidentic/types": patch
---

Pre-publish audit fixes (packaging, correctness, security, quality).

- **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
- **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
- **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
- **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
- **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
- **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
- **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.
