---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/memory": minor
---

Complete memory-engine consolidation duties (§6.5 duties 2 & 3, §9.8).

- **Fact TTL / staleness (duty 3):** `AssertFactInput.ttlMs` stores `Fact.expiresAt = validFrom + ttlMs`; new `GraphPort.sweepExpired(scope, now)` invalidates every currently-valid fact whose `expiresAt <= now` by setting `validUntil = now` — invalidated, NOT deleted (temporal audit, §6.6). Sqlite migration v8 adds `facts.expires_at`. Surfaced as `Memory.sweepExpiredFacts(scope, now?)`. New graph conformance cases.
- **Archival dedup/merge (duty 2):** `Memory.dedupeArchival(scope, { threshold, mergeModel })` lists a scope's archived passages (new optional `VectorPort.list?`, implemented on the in-memory fake), finds near-duplicates by cosine similarity, LLM-merges each pair into ONE grounded canonical passage, and replaces the duplicate's vector. A malformed merge response leaves both originals intact (never lose data). Merge `usage` surfaced for `cost.background`.
- **Single-flight scheduler (§9.8):** new in-process `ConsolidationScheduler` runs distillation + staleness sweep + (optional) dedup per scope with single-flight + debounce (a request during a run coalesces into one follow-up), aggregating usage into one `MaintenanceResult.usage`.

Deferred to later plans: the durable background-job queue with dead-letter (§9), block-hygiene auto-fill/eviction (§6.2), skill-memory rollup, the benchmark harness (§6.10), optimizer-tuned consolidation prompts, and loop wiring of `cost.background`.
