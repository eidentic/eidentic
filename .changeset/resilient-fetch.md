---
"@eidentic/types": patch
"@eidentic/tools": minor
---

Add `resilientFetch`/`fetchJson` helpers to `@eidentic/tools` (timeout, 5xx/network retry, agent-abort-linked). Wire into Tavily/Exa/Serper/SearXNG adapters and `web_fetch`/`web_search` so every outbound HTTP call has a per-request timeout (default 10 s), automatic retry on 5xx or network errors, and is cancelled when the agent run aborts. Zero new runtime dependencies — plain `fetch` + `AbortController`. `WebSearchOptions.signal` added to `@eidentic/types` (ESM-only ky conflicts with the dual CJS build; plain fetch used instead).
