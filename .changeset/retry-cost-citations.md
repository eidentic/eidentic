---
"@eidentic/core": minor
"@eidentic/memory": minor
"@eidentic/rag": minor
"@eidentic/types": minor
---

Three backward-compatible developer improvements:

**Feature 1 — Model retry/backoff:** `AgentConfig.modelRetry?: { maxAttempts: number; backoffMs?: number }` retries transient failures (network errors, 429, 5xx) on the `complete()` path only. Streaming is never buffered or retried. `AbortError` is never treated as transient. Default is OFF (no `modelRetry` config).

**Feature 2 — Per-turn cost visibility:** Every streamed `assistant` event now carries a `usage: Usage` field with that turn's token counts. The terminal `result` event already carried cumulative `usage` and `cost`; this change surfaces the per-turn breakdown mid-run.

**Feature 3 — RAG citations:** `MemoryEvent` and `MemorySnippet` gain an optional `metadata?: { source?: string; page?: number; [k: string]: unknown }` field. `Memory.ingest` stores it; `Memory.retrieve` returns it per snippet. The `<recall>` block injected into the system prompt now prefixes each snippet with `[source: X]` when `metadata.source` is set — fully backward-compatible when absent. `ingestDocument` attaches `metadata: { source: <url or docId> }` per chunk automatically. Durable-store persistence of metadata is a follow-up.
