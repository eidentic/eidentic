---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/memory": minor
"@eidentic/core": minor
---

Temporal knowledge graph (Tier-4, §6.6): facts are timestamped, invalidatable edges `(subject, predicate, object)`. New `GraphPort` (`assertFact`/`queryFacts`) implemented by `InMemoryStore` and `SqliteStore` (new SQLite migration v4 `facts` table). A contradicting assertion for the same `(subject, predicate)` invalidates the prior fact by setting its `validUntil` — superseded, never deleted — enabling point-in-time ("what was believed at time T") queries. `Memory` gains an optional `graph?: GraphPort`: it delegates `assertFact`/`queryFacts` and folds matching currently-valid facts into recall as a basic entity signal (RRF-fused alongside lexical/semantic). `@eidentic/core` exposes `graph_query` (read-only) and `graph_assert` (destructive) tools to the agent whenever the memory exposes a graph. Drop-in unchanged: graph is opt-in and the no-graph loop/registry path is byte-for-byte identical. Deferred to a later release: sleep-time consolidation agent, episodic→semantic distillation, a normalized `entities` table with entity resolution, and advanced entity-signal fusion.
