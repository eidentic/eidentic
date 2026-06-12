# @eidentic/libsql

LibSQL / Turso store adapter for Eidentic — durable agent memory, session records,
temporal graph facts, and durable-execution checkpoints over `@libsql/client`. Pure-JS,
no native addon, works in serverless and edge environments. Use this instead of
`@eidentic/sqlite` in Next.js, Cloudflare Workers, and bundler pipelines.

## Install

```bash
pnpm add @eidentic/libsql
```

## Usage

```ts
import { LibsqlStore } from "@eidentic/libsql";
import { Agent, AIModel } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

// Local file (development)
const store = new LibsqlStore("file:eidentic.db");

// Turso remote (production)
const store = new LibsqlStore({
  url: process.env.LIBSQL_URL!,
  authToken: process.env.LIBSQL_AUTH_TOKEN,
});

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

for await (const ev of agent.query("Hello", { sessionId: "s-1" })) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
}
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
