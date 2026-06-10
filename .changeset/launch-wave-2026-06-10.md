---
"@eidentic/eval": minor
"@eidentic/cli": minor
"@eidentic/mcp": minor
"@eidentic/model": minor
"@eidentic/prompts": minor
"@eidentic/browser": minor
"@eidentic/memory": minor
"@eidentic/types": minor
"@eidentic/bench": minor
"@eidentic/workflow": patch
"@eidentic/sqlite": minor
"@eidentic/libsql": minor
"@eidentic/postgres": minor
"eidentic": patch
"create-eidentic": patch
---

Launch-readiness + capability wave (PRs #164–#175).

New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).
