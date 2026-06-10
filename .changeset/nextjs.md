---
"@eidentic/nextjs": minor
---

`@eidentic/nextjs` — Next.js App Router integration package.

Removes the two biggest Next.js dogfooding footguns:

- **`withEidentic(agent, opts?)`** — creates a typed Next.js App Router `POST` route handler. Reads `{ input | message, sessionId, userId }` from the JSON body, calls `agent.query` with `req.signal` for cooperative cancellation, and streams the response. Supports `opts.protocol`:
  - `"ai-sdk-ui"` (default) — delegates to `@eidentic/server`'s `toUIMessageStreamResponse` so a `useChat` frontend works out of the box.
  - `"ndjson"` — raw `StreamEvent` NDJSON stream for `@eidentic/react`'s `useEidenticStream`.
- **`eidenticNextConfig(userConfig?)`** — merges `serverExternalPackages: ["better-sqlite3"]` into your `next.config` so the native addon is never bundled by Webpack.

Usage:
```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { myAgent } from "@/lib/agent";

export const runtime = "nodejs"; // required
export const POST = withEidentic(myAgent);
```

```ts
// next.config.ts
import { eidenticNextConfig } from "@eidentic/nextjs";
export default eidenticNextConfig({ /* ...existing config */ });
```
