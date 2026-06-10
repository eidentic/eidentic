---
"@eidentic/types": minor
"@eidentic/memory": minor
---

Memory completion: passive extraction (§6.8), org/shared scopes (§6.7), block-health (§6.5).

**`@eidentic/types`** — two new `Scope` kinds:
- `{ kind: "org"; agentId; orgId }` → `scopeKey` = `org:<agentId>:<orgId>` — tenant-wide institutional knowledge
- `{ kind: "shared"; blockId }` → `scopeKey` = `shared:<blockId>` — explicitly shared block, intentionally NOT agent-scoped so any two agents resolve the same key (cross-agent sharing, §8)

**`@eidentic/memory`** — three additions:
- `passiveExtract(text, subject?)` — deterministic rule-based SPO extraction (NO LLM). Handles: `my name is <Name>` → `(user, name, …)`, `I love/like/prefer/enjoy <thing>` → `(user, likes, …)`, `I work at|for <Company>` → `(user, works_at, …)`, `I work as / I'm a / I am a <role>` → `(user, role|is, …)`. Precision-first (prefers false-negatives over garbage facts); objects capped at 80 chars; identical triples deduped. Exported as `PassiveFact` + `passiveExtract`.
- `MemoryOptions.extraction?: "agentic" | "passive" | "hybrid"` (default `"agentic"`). When `"passive"` or `"hybrid"` and a `graph` is configured, `ingest` runs `passiveExtract` on every event and asserts each fact with `confidence: 0.6`; failures (temporal-order violations, bad triples) are silently dropped — ingest never throws. `"agentic"` preserves byte-for-byte the previous ingest behavior.
- `Memory.blockHealth(scope): Promise<BlockHealth[]>` — snapshot of every always-in-context block: `{ label, length, limit?, fillRatio?, isEmpty, required }`. Includes synthetic entries for any `requiredBlocks` label not yet in the store (foundation for §6.5 hygiene nudge). `MemoryOptions.requiredBlocks?: string[]` marks labels as mandatory.

Deferred: archival dedup/merge, fact-TTL/staleness sweep, durable-background consolidation scheduling, benchmark harness (§6.10).
