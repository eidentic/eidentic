# @eidentic/postgres

PostgreSQL store adapter for Eidentic — durable agent memory, session records, temporal
knowledge graph facts, and durable-execution checkpoints over a `pg.Pool` or PGlite.
Implements `StorePort`, `GraphPort`, and `DurablePort` from `@eidentic/types`. Runs
migrations automatically on first use.

## Install

```bash
pnpm add @eidentic/postgres pg
```

## Usage

```ts
import { PostgresStore } from "@eidentic/postgres";
import pg from "pg";
import { Agent, AIModel } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = await PostgresStore.create({ client: pool });

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
