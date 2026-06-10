---
"@eidentic/core": minor
"@eidentic/eval": minor
"@eidentic/memory": minor
"@eidentic/lancedb": minor
"@eidentic/skills": minor
---

Clarify public API names (pre-1.0 renames):

- `LanceVectorStore` → `LanceDBVectorStore` (`@eidentic/lancedb`)
- `agentRunner` → `createRunner` (`@eidentic/eval`)
- `discoveryTools` → `lazyDiscoveryTools` (`@eidentic/core`)
- `dedupeArchival` → `deduplicateArchival` (`@eidentic/memory` — method on `Memory` + `ConsolidationScheduler`)
- `NoneSandbox` → `NoopSandbox` (`@eidentic/core`)
- `EAGER_CORE` → `EAGER_TOOL_IDS` (`@eidentic/core`)
- `globMatch` → `matchSkillGlob` (`@eidentic/skills` only; `@eidentic/core`'s `globMatch` is unchanged)

Tooling bump (root dev dependency, no changeset required):
- `typescript` `^5.7.0` → `^5.9.0`

Note: `@electric-sql/pglite` bump to `^0.5.0` was attempted but reverted — pglite 0.5 removed
the `./vector` sub-path entirely (pgvector no longer bundled, no standalone replacement package
available as of 2026-06-07). Staying on `^0.4.6` until upstream ships a compatible upgrade path.
