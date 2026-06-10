---
title: Getting Started
description: Install Eidentic and build your first agent in under five minutes.
---

Eidentic is a TypeScript library for building production-grade AI agents. It ships with self-improving memory, self-developing skills, multi-agent orchestration, and the production fundamentals (durability, cost control, rate-limiting, security, GDPR erasure) baked in — not bolted on.

## Install

```bash
npm install eidentic ai @ai-sdk/anthropic
```

`eidentic` is the umbrella package that re-exports `@eidentic/core`, `@eidentic/types`, `@eidentic/model`, `@eidentic/sqlite`, and `@eidentic/memory`. For serverless or edge environments see the [Next.js guide](/guides/nextjs) and the [Runtimes guide](/guides/runtimes) for the right store to use.

## Build an agent

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new Agent({
  id: "assistant",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});
```

`AgentConfig` fields:

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique agent identifier |
| `model` | Yes | `AIModel` wrapping any AI SDK provider |
| `store` | Yes | Persistence adapter (SQLite, libSQL, Postgres, …) |
| `tools` | No | Array of tools the agent may use |
| `instructions` | No | System-level instructions / persona |
| `memory` | No | `Memory` instance for multi-session recall |

## Query and stream

`agent.query()` returns an async iterable of `StreamEvent` objects. The final event has `type: "result"` with `subtype: "success"` (or an error/limit subtype).

```ts
for await (const event of agent.query("What did we decide last week?", {
  sessionId: "user-42",
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  } else if (event.type === "result") {
    console.log("\n\nDone. Usage:", event.usage);
  }
}
```

**Options:**

| Option | Description |
|---|---|
| `sessionId` | Identifies the conversation session (required for stateful history) |
| `userId` | Ties session to a user; enables per-user memory recall |
| `signal` | `AbortSignal` for cooperative cancellation |

## Five-minute path

1. **Install** — `npm install eidentic ai @ai-sdk/anthropic`
2. **Create an agent** — pass `id`, `model`, and `store`
3. **Call `agent.query()`** — iterate the stream, write text deltas
4. **Add memory** — attach a `Memory` instance and pass `userId` to enable cross-session recall ([Memory 101](/guides/memory))
5. **Deploy** — embed in Express, Next.js App Router, Cloudflare Workers, or use `@eidentic/server` for a ready-made Hono service ([Server & Studio](/guides/server-studio))

## Scaffold a project

The `create-eidentic` scaffolder sets up a full project in one command:

```bash
npm create eidentic@latest my-agent
cd my-agent
```

Or use the CLI:

```bash
npm install -g eidentic
eidentic init
```

## Debug logging

Set `DEBUG=eidentic:*` to enable verbose, namespaced logs (model calls, tool dispatch, memory recall, cost) with secrets redacted:

```bash
DEBUG=eidentic:* node my-agent.js
```

Scope to a specific namespace: `DEBUG=eidentic:tool,eidentic:cost`.
