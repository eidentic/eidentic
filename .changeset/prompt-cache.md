---
"@eidentic/types": minor
"@eidentic/model": minor
"@eidentic/core": minor
---

Add opt-in prompt caching (`AgentConfig.promptCache`). When `true`, each model call marks
the stable system-prompt prefix as cacheable via the AI SDK's provider-options mechanism —
Anthropic receives `cacheControl: { type: "ephemeral" }` on the system message; other
providers ignore the hint gracefully. Cache hits are observable via `Usage.cachedInputTokens`
and the OTel `kv_cache_hit_rate` attribute. Off by default; requests are byte-identical when
the option is absent.
