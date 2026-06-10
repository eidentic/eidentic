---
"@eidentic/server": minor
---

Add `toUIMessageStreamResponse` and `toUIMessageStream` to `@eidentic/server`.

Converts a Eidentic `AsyncIterable<StreamEvent>` into a Vercel AI SDK v6 UI
message-stream `Response`, enabling direct `useChat` (and CopilotKit) support
in Next.js App Router routes:

```ts
// app/api/chat/route.ts
import { toUIMessageStreamResponse } from "@eidentic/server";

export async function POST(req: Request) {
  const { messages, sessionId } = await req.json();
  return toUIMessageStreamResponse(
    myAgent.query(messages.at(-1)?.content ?? "", { sessionId }),
  );
}
```

**Mapping:**
- `stream.delta` → `text-delta` (streaming token)
- `assistant` text blocks → `text-start` + `text-delta` + `text-end`
- `assistant` tool_use blocks → `tool-input-available`
- `tool.result` (success) → `tool-output-available`
- `tool.result` (error) → `tool-output-error`
- `result` → `finish` with finishReason (`success`→`stop`, `max_tokens`→`length`, `error`→`error`, others→`other`)
- `session.init` / `compaction` → silently ignored

Adds `ai` as a runtime dependency of `@eidentic/server`.
