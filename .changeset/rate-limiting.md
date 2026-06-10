---
"@eidentic/types": minor
"@eidentic/server": minor
---

§20.3 tenant token-bucket rate limiting — per-request server-enforced 429 + Retry-After.

- **`RateLimitResult` + `RateLimiterPort`** added to `@eidentic/types` ports and exported from the barrel. `RateLimiterPort.acquire(key, cost?)` returns `{ ok, retryAfterMs?, remaining? }`.
- **`InMemoryTokenBucketLimiter`** (new `@eidentic/server/src/rate-limit.ts`): classic token bucket with injectable `now` for deterministic testing. Per-key lazy bucket creation; refills on each `acquire` call based on elapsed time; `remaining` tracks available tokens. The key map is unbounded — fine for v1 single-process use; a Redis/store-backed limiter is appropriate for multi-process deployments.
- **`ServerOptions.rateLimiter?: RateLimiterPort`** + **`ServerOptions.rateLimitKey?`**: when set, every `POST /v1/agents/:id/query` and `/resume` checks the limiter AFTER auth resolves and BEFORE agent resolution or SSE stream open. Throttled requests receive HTTP 429 with `Retry-After: <ceil(ms/1000)>` and JSON body `{ error: "rate_limited", retryAfterMs }`. When absent, the check is skipped — the hot path is byte-identical to pre-rate-limit behaviour.

Deferred (out of scope for v1): per-model/per-tool-call limiting, fleet-wide Redis coordination, dynamic `Retry-After` header parsing from upstream provider 429s, per-agent concurrency caps.
