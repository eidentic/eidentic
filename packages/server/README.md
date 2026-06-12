# @eidentic/server

Hono HTTP server for Eidentic agents — a ready-made multi-agent backend with a streaming
query endpoint, async fire-and-poll runs, workflow run registry, built-in auth, rate-limiting,
quotas, and an AI SDK UI-compatible stream format. Deploy anywhere Hono runs: Node, Bun,
Deno, Cloudflare Workers.

## Install

```bash
pnpm add @eidentic/server
```

## Usage

```ts
import { createServer, serveNode, ApiKeyAuth } from "@eidentic/server";
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});

const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({ "key_live_abc123": { userId: "u-1" } }),
});

// Node.js
await serveNode(app, { port: 3000 });
// POST /v1/agents/support/query  →  NDJSON stream
// GET  /v1/runs/:id/status       →  async run status
// GET  /v1/workflows             →  workflow run list
```

The stream format is compatible with Vercel AI SDK's `useChat` and `@eidentic/react`'s
`useEidenticStream` out of the box.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
