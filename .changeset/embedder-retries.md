---
"@eidentic/model": minor
"@eidentic/bench": patch
---

`AIEmbedder.create` accepts a `maxRetries` option, forwarded to the AI SDK's `embed`/`embedMany`.
The AI SDK retries transient failures (including provider rate limits / 429s) with exponential
backoff and honours `retry-after`, so high-volume ingest against a rate-limited embedding provider
no longer fails after the default 2 attempts. The LongMemEval harness caps over-long embedding
inputs below the typical 8192-token embedder window.
