# @eidentic/tools

Built-in agent tools for Eidentic — file read/write/list, bash command execution,
resilient HTTP fetch, web search (Tavily / Exa / Serper / SearXNG), and a sandbox
confinement helper. All tools respect Eidentic's deny-by-default permission model.

## Install

```bash
pnpm add @eidentic/tools
```

## Usage

```ts
import { fileTools, bashTool, webTools, webSearchFromEnv } from "@eidentic/tools";
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
      searchProvider: webSearchFromEnv() ?? undefined,
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

`webSearchFromEnv()` picks a provider from environment variables:

| Env var | Provider |
|---|---|
| `TAVILY_API_KEY` | Tavily |
| `EXA_API_KEY` | Exa |
| `SERPER_API_KEY` | Serper |
| `SEARXNG_BASE_URL` | SearXNG (self-hosted) |

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
