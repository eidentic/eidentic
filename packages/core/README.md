# @eidentic/core

Core agent primitives for Eidentic — the `Agent` class, tool registry, memory and graph
tools, reasoning strategies, guardrails, permission model, and context compaction. This
is the engine that all other Eidentic packages build on.

## Install

```bash
pnpm add @eidentic/core
```

Runtime: Node.js 22+. When used with `@eidentic/model`, bring AI SDK 7-compatible
provider packages.

## Usage

```ts
import { Agent, AIModel, createTool, SqliteStore } from "eidentic"; // umbrella re-export
// or import directly:
import { Agent, createTool, eidenticGuardrails, permissions, policies, ToolRegistry, NoopLogger } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { SqliteStore } from "@eidentic/sqlite";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const weatherTool = createTool({
  id: "get_weather",
  description: "Returns the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ input }) => ({ temp: 22, condition: "sunny", city: input.city }),
});

const agent = new Agent({
  id: "assistant",
  instructions: "You are a concise weather assistant.",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
  tools: [weatherTool],
  policy: policies.customerReply({ maxCostUsd: 0.10 }),
  guardrails: eidenticGuardrails.pii({ input: "redact", output: "redact" }),
  permissions: permissions.denyByDefault({ allow: ["get_weather"] }),
  modelResponseLimits: {
    maxBytes: 1024 * 1024,
    maxEstimatedTokens: 128_000,
  },
});

for await (const ev of agent.query("What's the weather in Berlin?", {
  sessionId: "s-1",
  principal: { userId: "viewer-1", orgId: "workspace-1" },
  memoryScope: { kind: "user", agentId: "assistant", userId: "contact-1" },
  guardrailInput: { userText: "What's the weather in Berlin?", channel: "chat" },
})) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
}
```

## Model output limits

Every model call has a hard 8 MiB output ceiling by default. Override it with
`modelResponseLimits.maxBytes`; optionally set `maxEstimatedTokens` for a second ceiling using a
conservative four-UTF-8-bytes-per-token streaming estimate and the provider's final token usage.
The limit covers text, thinking/tool payloads, and structured response objects.

Complete responses are checked before persistence or exposure. Streaming chunks are checked before
they are emitted; on overflow the provider request is cancelled, only the already-emitted bounded
partial text is persisted with `interrupted: "output_limit"`, and the run ends with a sanitized
`ModelResponseLimitError` result.

Built-in strategies apply the same boundary to planner/critic calls. Custom strategies should use
`ctx.react(...)` or call `ctx.enforceModelResponseLimits?.(response)` before inspecting a model
response obtained directly.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
