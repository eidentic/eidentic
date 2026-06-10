---
title: Tools & Web Search
description: Built-in tools, web search providers, and SSRF-guarded fetch.
---

Eidentic ships a set of built-in tools in `@eidentic/tools` for file access, bash execution, and web operations. All tools run through `SandboxPort` — on `NoopSandbox` (the default), untrusted execution is refused unless you explicitly enable it.

## Install

```bash
npm install @eidentic/tools
```

## Built-in tools

### File tools

```ts
import { fileTools } from "@eidentic/tools";

const agent = new Agent({
  // ...
  tools: fileTools({ rootDir: "./workspace" }),
});
```

`fileTools` exposes `read_file`, `write_file`, `list_files`, and `delete_file`. The `rootDir` option confines all operations to that directory — the model cannot read or write outside it.

### Bash tool

```ts
import { bashTool } from "@eidentic/tools";

const agent = new Agent({
  // ...
  tools: [bashTool()],
});
```

By default `bashTool` requires a `SandboxPort` to execute. Pass an `E2BSandbox` (from `@eidentic/e2b`) to run commands in a secure microVM:

```ts
import { bashTool } from "@eidentic/tools";
import { E2BSandbox } from "@eidentic/e2b";

const agent = new Agent({
  // ...
  sandbox: new E2BSandbox({ apiKey: process.env.E2B_API_KEY! }),
  tools: [bashTool()],
});
```

### Web tools

`webTools` returns a `web_fetch` tool and, optionally, a `web_search` tool. All outbound requests from `web_fetch` are guarded against SSRF.

```ts
import { webTools } from "@eidentic/tools";

const agent = new Agent({
  // ...
  tools: webTools({
    allowlist: ["docs.example.com", "api.example.com"],
    searchProvider: mySearchProvider,
  }),
});
```

## SSRF guard

`web_fetch` rejects all requests to private/loopback/link-local addresses and cloud metadata endpoints (e.g. `169.254.169.254`) regardless of the allowlist setting. This is always-on and cannot be disabled.

The `allowlist` option controls public hosts:

| Value | Effect |
|---|---|
| Omitted (`undefined`) | Any public host may be fetched |
| `[]` (empty array) | All fetches are denied |
| `["example.com"]` | Only `example.com` and its subdomains are allowed |

Allowlist matching is dot-boundary suffix: `"example.com"` allows `api.example.com` but NOT `notexample.com`.

## Web search providers

`webTools` accepts a `searchProvider` (a `WebSearchPort`). Four adapters are available:

```ts
import {
  tavilySearch,
  exaSearch,
  serperSearch,
  searxngSearch,
  webSearchFromEnv,
} from "@eidentic/tools";

// Auto-detect from environment variables:
const provider = webSearchFromEnv();
//   TAVILY_API_KEY → tavilySearch
//   EXA_API_KEY    → exaSearch
//   SERPER_API_KEY → serperSearch

// Or configure explicitly:
const provider = tavilySearch({ apiKey: process.env.TAVILY_API_KEY! });
```

API keys are **never** passed to the model — they are resolved via `ctx.secrets` inside the tool implementation.

## Custom tools

Use `createTool` from `@eidentic/core` to define your own:

```ts
import { createTool } from "@eidentic/core";
import { z } from "zod";

const lookupOrderTool = createTool({
  name: "lookup_order",
  description: "Look up a customer order by ID.",
  parameters: z.object({
    orderId: z.string().describe("The order ID to look up"),
  }),
  execute: async ({ orderId }) => {
    const order = await db.orders.findById(orderId);
    return order ?? { error: "Order not found" };
  },
});

const agent = new Agent({
  // ...
  tools: [lookupOrderTool],
});
```

## Permissions

Tool access is deny-by-default. Use `permissions` in `AgentConfig` to control what the model can call:

```ts
const agent = new Agent({
  // ...
  permissions: {
    allow: ["lookup_order", "web_search"],
    deny: ["write_file", "bash"],
  },
});
```

Glob patterns are supported: `"read_*"` allows all tools starting with `read_`.

## MCP tools

Consume external MCP servers as first-class Eidentic tools:

```ts
import { mcpTools } from "@eidentic/mcp";

const agent = new Agent({
  // ...
  tools: await mcpTools({
    transport: { type: "stdio", command: "npx", args: ["-y", "my-mcp-server"] },
  }),
});
```
