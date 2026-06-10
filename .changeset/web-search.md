---
"@eidentic/types": minor
"@eidentic/tools": minor
---

Pluggable web-search: `WebSearchPort` in `@eidentic/types` + Tavily/Exa/Serper/SearXNG adapters (plain fetch, zero new runtime deps) + env auto-detect (`TAVILY_API_KEY` → `EXA_API_KEY` → `SERPER_API_KEY` → `SEARXNG_URL`) + `web_search` tool now present by default with a helpful unconfigured message (no crash, no throw); model never sees API keys (§10.3 preserved); SearXNG is the free self-host path.
