---
"@eidentic/tools": minor
---

Use anonymous Parallel Search MCP (Fast mode) for an enabled `web_search` when no
provider is configured. Add `parallelSearch()` with a bounded MCP deadline,
cancellation and the existing title/URL/snippet result contract.

Migration: unconfigured search now sends queries to `https://search.parallel.ai/mcp`
instead of returning `{ configured: false, message }`. Set `webSearch: false`, deny
`web_search` in the agent permission policy, or inject your chosen `searchProvider`
to control this behavior. Injected providers, the legacy callback and configured
environment providers keep their existing priority. `webSearchFromEnv({})` still
returns `null`, and `web_fetch` retains its HTTPS and egress allowlist checks.
