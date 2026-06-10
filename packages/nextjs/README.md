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
// Any React component
import { useChat } from "ai/react";

export function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({ api: "/api/chat" });
  return (/* render messages and input */);
}
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
