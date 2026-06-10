---
"@eidentic/memory": minor
---

Add `Consolidator` — sleep-time memory consolidation (§6.5). It distills raw conversation text/events into durable subject-predicate-object facts via a consolidation model and asserts them into the temporal knowledge graph (`GraphPort`). Grounded reflection drops any fact whose verbatim supporting quote is absent from the source (no ungrounded invention); usage is surfaced for cost transparency. Deferred to later plans: archival dedup/merge, staleness/TTL resolution, block hygiene, durable background scheduling, cost-governor integration.
