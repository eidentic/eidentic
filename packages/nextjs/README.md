# @eidentic/nextjs

Next.js App Router integration for Eidentic — `withEidentic` wraps an agent as a
`POST` route handler that emits an AI SDK UI-compatible stream, and `eidenticNextConfig`
patches your `next.config.ts` to prevent native-addon bundling errors (`better-sqlite3`,
etc.). Works with `useChat` from the Vercel AI SDK out of the box.

## Install

```bash
pnpm add @eidentic/nextjs @eidentic/libsql
```

> Use `@eidentic/libsql` (pure-JS) instead of `@eidentic/sqlite` (native addon) in Next.js
> and other bundler environments.

## Usage

```ts
// next.config.ts
import { eidenticNextConfig } from "@eidentic/nextjs";
import type { NextConfig } from "next";

export default eidenticNextConfig({} satisfies NextConfig);
```

```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { Agent, AIModel } from "eidentic";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

export const runtime = "nodejs";

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new LibsqlStore("file:eidentic.db"),
});

export const POST = withEidentic(agent);
```

```tsx
// Client component — Vercel AI SDK v5+
import { useChat } from "@ai-sdk/react";

export function Chat() {
  // `useChat` POSTs `{ messages: [...] }`; `withEidentic` reads the newest user message out of the
  // box — no `prepareSendMessagesRequest` / request transform needed. Pass a stable `sessionId`
  // (via the transport body) so the agent persists and recalls the conversation across reloads.
  const { messages, sendMessage } = useChat();
  return null; // render `messages`; send with `sendMessage({ text })`
}
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
