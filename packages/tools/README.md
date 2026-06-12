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
  model,
  store,
  tools: [
    ...fileTools({ root: process.cwd() }),      // read_file, write_file, list_files
    bashTool(new NoopSandbox()),                 // run_bash (swap NoopSandbox for a real sandbox)
    ...webTools({ searchProvider: webSearchFromEnv() ?? undefined }), // web_fetch, web_search
  ],
  // Deny-by-default: only the tools above are available
});
```

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
