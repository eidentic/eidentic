---
"@eidentic/server": patch
---

Fix three server-level resource leaks identified in the internal audit.

- **Rate-limiter memory leak** (`InMemoryTokenBucketLimiter`): the `buckets` Map
  previously grew one entry per unique tenant key forever. An opportunistic sweep
  now evicts entries whose `lastRefillMs` is older than twice the full-refill window
  (`capacity / refillPerSec * 2000 ms`) — a threshold at which the bucket is
  guaranteed to be at full capacity, making eviction semantically lossless. The sweep
  runs at most once per full-refill window; no background timer is used. A `bucketCount`
  accessor is exposed for testing.

- **Double `readEvents` on SSE reconnect**: when a client reconnected via
  `Last-Event-ID` on an in-progress run (fall-through from the replay path), both
  the `/query` and `/resume` handlers were calling `agent.store.readEvents(sessionId)`
  twice — once in the replay block and again in the live-streaming path for `baseSeq`
  computation. The second call is now eliminated by caching the first result and
  reusing it in the live path.

- **`BatchRunner` large-batch scalability**: `BatchRunOptions.collectResults` (default
  `true`) lets callers opt out of in-memory result accumulation for very large batches.
  When `false`, `BatchResult.results` is empty while `aggregate` totals remain accurate;
  results should be drained via the `onProgress` callback instead.
