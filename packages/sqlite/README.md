# @eidentic/sqlite

SQLite store adapter for Eidentic — durable agent memory, session records, temporal knowledge
graph facts, and durable-execution checkpoints over `better-sqlite3`. Implements `StorePort`,
`GraphPort`, and `DurablePort` from `@eidentic/types`. Best for Node.js and Bun; for
serverless/edge use `@eidentic/libsql` instead.

## Install

```bash
pnpm add @eidentic/sqlite
```

`better-sqlite3` is a peer dependency and must be installed separately:

```bash
pnpm add better-sqlite3
```

## Usage

```ts
import { SqliteStore } from "@eidentic/sqlite";
import { Agent, AIModel } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const store = new SqliteStore("./eidentic.sqlite");
// or in-memory:
const memStore = new SqliteStore(":memory:");

const agent = new Agent({
  id: "assistant",
  instructions: "You are a helpful assistant.",
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
