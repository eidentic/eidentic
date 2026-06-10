# @eidentic/core

Core agent primitives for Eidentic — the `Agent` class, tool registry, memory and graph
tools, reasoning strategies, guardrails, permission model, and context compaction. This
is the engine that all other Eidentic packages build on.

## Install

```bash
pnpm add @eidentic/core
```

Peer: `ai ^6.0.0` (Vercel AI SDK — bring your own provider package).

## Usage

```ts
import { Agent, AIModel, createTool, SqliteStore } from "eidentic"; // umbrella re-export
// or import directly:
import { Agent, createTool, ToolRegistry, NoopLogger } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { SqliteStore } from "@eidentic/sqlite";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const weatherTool = createTool({
  name: "get_weather",
  description: "Returns the current weather for a city.",
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ temp: 22, condition: "sunny", city }),
});

const agent = new Agent({
  id: "assistant",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
  tools: [weatherTool],
  costCeiling: { usd: 0.10 }, // hard stop per turn
});

for await (const ev of agent.query("What's the weather in Berlin?", { sessionId: "u-1" })) {
  if (ev.kind === "text_delta") process.stdout.write(ev.delta);
}
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
