---
"@eidentic/types": minor
"@eidentic/server": minor
---

§20.4 per-tenant cumulative quotas ($/tokens/runs) — 402 on hard cap + soft-cap warning header.

- **`QuotaUsage`, `QuotaLimits`, `QuotaCheck`, `QuotaPort`** added to `@eidentic/types` ports and exported from the barrel. `QuotaPort.check(key)` returns `{ ok, warn?, reason?, usage? }`; `QuotaPort.record(key, { usd, tokens })` accumulates spend (+1 run). Hard ceilings (hardUsd / hardTokens / hardRuns) block; soft ceiling (softUsd) warns.
- **`InMemoryQuota`** (new `@eidentic/server/src/quota.ts`): in-memory cumulative ledger. Constructor accepts uniform `QuotaLimits` or a per-key `(key) => QuotaLimits` resolver. Shares the `CostBreakdown` ledger (foreground+background+cached count via the terminal `result` event's `usage.inputTokens + outputTokens` + `cost.usd`). A `reset(key?)` helper supports tests. The key map is unbounded — fine for v1 single-process use; a store/Redis-backed ledger is appropriate for multi-process deployments.
- **`ServerOptions.quota?: QuotaPort`** + **`ServerOptions.quotaKey?`**: when set, every `POST /v1/agents/:id/query` and `/resume` checks the ledger AFTER auth + rate-limit and BEFORE agent resolution or SSE stream open. Hard-cap exceeded → HTTP **402 Payment Required** with JSON body `{ error: "quota_exceeded", reason, usage }` (no stream). Soft-cap crossed → `X-Eidentic-Quota-Warning: soft-limit` response header (stream continues normally). After the SSE loop ends, the terminal `result` event's `usage` + `cost` is recorded via `quota.record(key, { usd, tokens })`. When absent, the check is skipped — the hot path is byte-identical to the no-quota behaviour.
- Quota key derivation shares the same default as `rateLimitKey`: `principal.apiKey ?? principal.userId ?? principal.orgId ?? "anonymous"`.

Deferred (out of scope for v1): storage quotas, monthly-window reset/approval flow, model-downgrade-on-soft, persistent/Redis ledger, background-spend attribution beyond what the terminal result reports.
