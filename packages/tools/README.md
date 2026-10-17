# @eidentic/tools

Built-in agent tools for Eidentic — file read/write/list, bash command execution,
resilient HTTP fetch, web search (Parallel / Tavily / Exa / Serper / SearXNG), and a sandbox
confinement helper. All tools respect Eidentic's deny-by-default permission model.

## Install

```bash
pnpm add @eidentic/tools
```

## Usage

```ts
import { fileTools, bashTool, webTools } from "@eidentic/tools";
import { Agent, NoopSandbox } from "eidentic";

const agent = new Agent({
  id: "coder",
  instructions: "Use only the configured tools and workspace.",
  model,
  store,
  tools: [
    ...fileTools({ root: process.cwd() }), // read_file, write_file, edit_file, glob, grep
    bashTool(new NoopSandbox()),            // bash (swap NoopSandbox for a real sandbox)
    ...webTools({
      allowlist: ["docs.example.com"],
    }), // web_fetch, web_search
  ],
  // Deny-by-default: only the tools above are available
});
```

`web_fetch` rejects URL credentials, non-global/private IPs and any hostname whose A/AAAA
answers include a non-global address. DNS is rechecked before every retry and redirect hop;
text responses have decompressed-byte and body-time limits. An omitted or empty `allowlist` denies
all arbitrary fetches, and HTTPS is required. The deprecated `unsafeAllowAnyPublicHost` and
`allowInsecureHttp` options exist only for controlled migration behind an equivalent egress policy.
Retries are limited to `GET`/`HEAD`; cross-origin redirects discard caller
headers, cookies, and referrer information before the next request. DNS validation and the
connection are still separate operations in the standard Fetch API, so high-risk deployments
should also enforce egress through a pinning proxy/firewall.

The same boundary is available to adapters through `assertSafeEgressUrl`, `safeFetch`, and
`safeFetchText`.

### Web search providers

`webTools()` uses free [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
when no search provider is configured. Search runs in anonymous Fast mode without an
account or API key. Queries are sent to `https://search.parallel.ai/mcp` only when the
agent invokes `web_search`; registering the tools makes no network request. Results keep
the existing `{ title, url, snippet }` shape. Anonymous service limits apply; provider and
transport failures return `{ error }` without switching providers.

Resolution order is `searchProvider`, the legacy `search` callback, environment providers
below, then Parallel. Explicit providers and configured credentials retain their precedence.
`webSearchFromEnv()` continues to return `null` when no environment provider is configured.
For an explicit Parallel provider, use `parallelSearch({ timeoutMs: 10_000 })` as
`searchProvider`; its deadline covers MCP connection, tool discovery and search. Cancellation
from the agent is forwarded to those requests. `maxResults` (1–20, default 5) limits the
returned results locally.

**Migration:** previously an enabled, unconfigured `web_search` returned
`{ configured: false, message }`. It now searches with Parallel. Set `webSearch: false` to
exclude search, deny `web_search` in the agent's permission policy to prevent execution, or
supply your chosen `searchProvider` to control where queries go. `web_fetch` still uses the
existing HTTPS/allowlist boundary; this search adapter does not enable MCP page fetching.

`webSearchFromEnv()` picks the first configured provider in this order:

| Env var | Provider |
|---|---|
| `TAVILY_API_KEY` | Tavily |
| `EXA_API_KEY` | Exa |
| `SERPER_API_KEY` | Serper |
| `SEARXNG_URL` | SearXNG (self-hosted) |

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
