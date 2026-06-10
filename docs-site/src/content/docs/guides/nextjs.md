---
title: Next.js Integration
description: Wire Eidentic into a Next.js App Router project with @eidentic/nextjs and @eidentic/libsql.
---

`@eidentic/nextjs` provides a single `withEidentic(agent)` helper that turns any Eidentic agent into a Next.js App Router route handler, handling streaming, request cancellation, and session wiring automatically.

## Install

```bash
npm install eidentic @eidentic/nextjs @eidentic/libsql ai @ai-sdk/anthropic
```

:::note[Use libSQL in Next.js]
The `eidentic` umbrella re-exports `SqliteStore` (backed by `better-sqlite3`, a native addon). Native addons do not bundle under the Next.js/Turbopack pipeline. Always use `@eidentic/libsql` instead — it is pure-JS and bundler-safe. You can still point it at a local SQLite file with `file:eidentic.db`.
:::

## `next.config` setup

Add `eidenticNextConfig` to your `next.config.ts` to ensure native addons are excluded from bundling:

```ts
// next.config.ts
import { eidenticNextConfig } from "@eidentic/nextjs";
import type { NextConfig } from "next";

const baseConfig: NextConfig = {
  // your existing config here
};

export default eidenticNextConfig(baseConfig);
```

`eidenticNextConfig` appends `"better-sqlite3"` to `serverExternalPackages`. If you never use `@eidentic/sqlite`, it is still harmless to include.

## Define your agent

Create a shared agent module so the instance is reused across requests (important for in-memory state and connection pooling):

```ts
// lib/agent.ts
import { Agent, AIModel } from "@eidentic/core";
import { LibsqlStore } from "@eidentic/libsql";
import { Memory } from "@eidentic/memory";
import { anthropic } from "@ai-sdk/anthropic";

const store = new LibsqlStore("file:eidentic.db");

export const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
  memory: new Memory({ store }),
  instructions: "You are a helpful support assistant.",
});
```

## Route handler with `withEidentic`

```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { agent } from "@/lib/agent";

export const runtime = "nodejs"; // required — Eidentic uses Node.js APIs

export const POST = withEidentic(agent);
```

`withEidentic` reads `{ message, sessionId, userId? }` from the request body, calls `agent.query()`, and streams the response.

### Protocol options

`withEidentic` accepts an options object with a `protocol` field:

```ts
export const POST = withEidentic(agent, { protocol: "ai-sdk-ui" });
```

| `protocol` | Stream format | Frontend |
|---|---|---|
| `"ai-sdk-ui"` (default) | AI SDK UI message-stream | `useChat` from `@ai-sdk/react` |
| `"ndjson"` | Raw `StreamEvent` NDJSON | `useEidenticStream` from `@eidentic/react` |

## Frontend with `@eidentic/react`

Install the React bindings:

```bash
npm install @eidentic/react
```

Use `useAgent` for a fully managed chat state, or `useEidenticStream` for lower-level stream access:

```tsx
// app/page.tsx
"use client";
import { useAgent } from "@eidentic/react";

export default function ChatPage() {
  const { messages, sendMessage, status } = useAgent({
    endpoint: "/api/chat",
    sessionId: "session-1",
    userId: "user-42",
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}
      <button
        onClick={() => sendMessage("Hello!")}
        disabled={status === "streaming"}
      >
        Send
      </button>
    </div>
  );
}
```

### `useChat` (AI SDK UI protocol)

If you prefer the `"ai-sdk-ui"` protocol (the default), any `useChat`-compatible hook works directly against the route:

```tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: "/api/chat",
    body: { sessionId: "session-1" },
  });

  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => (
        <p key={m.id}>{m.content}</p>
      ))}
      <input value={input} onChange={handleInputChange} />
      <button type="submit">Send</button>
    </form>
  );
}
```

## Using per-user memory

Pass `userId` in the request body and wire it to the agent query via `withEidentic`:

```ts
// withEidentic reads userId from the request body automatically
// Just make sure your frontend sends it:
const { messages, sendMessage } = useAgent({
  endpoint: "/api/chat",
  sessionId: "session-1",
  userId: "user-42",    // enables per-user recall
});
```

See [Memory 101](/guides/memory) for how `userId` drives the memory engine.

## Full project structure

```
my-app/
├── app/
│   ├── api/chat/route.ts    # withEidentic handler
│   └── page.tsx             # useAgent / useChat frontend
├── lib/
│   └── agent.ts             # shared Agent instance
├── next.config.ts           # eidenticNextConfig
└── package.json
```
