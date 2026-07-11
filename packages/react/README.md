# @eidentic/react

React hooks for building chat UIs powered by Eidentic agents.

## Two integration paths

Eidentic does not lock you into its hooks or its UI components. Choose the path
that fits your stack:

### Path A — `useEidenticStream` / `useAgent` (fully custom UI)

Use these hooks when you own the full frontend and want direct access to every
byte the agent emits — streaming deltas, tool calls, cost, suspension, and
raw events.

### Path B — Vercel AI SDK `useChat` / CopilotKit (drop-in)

If you use `@eidentic/nextjs` (or call `toUIMessageStreamResponse` from
`@eidentic/server` in a custom route handler), the Eidentic server emits an
**AI SDK UI-compatible stream**. This means you can point any AI SDK `useChat`
hook — or a CopilotKit runtime — directly at a Eidentic API route with zero
Eidentic-specific client code.

```ts
// app/api/chat/route.ts  (Next.js App Router)
import { withEidentic } from "@eidentic/nextjs";
import { myAgent } from "@/lib/agent";

export const runtime = "nodejs";
// `withEidentic` uses `toUIMessageStreamResponse` from @eidentic/server
// which emits the AI SDK UIMessageStream protocol.
export const POST = withEidentic(myAgent);
```

```tsx
// Any React component
import { useChat } from "@ai-sdk/react"; // Vercel AI SDK

export function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: "/api/chat",
  });
  // render messages ...
}
```

No `@eidentic/react` import required. The `@eidentic/nextjs` route handler is
protocol-compatible with `useChat` out of the box.

---

## Path A — `useAgent` quick start

```tsx
import { useAgent } from "@eidentic/react";

export function Chat() {
  const { messages, status, suspension, send, stop, resume, regenerate } =
    useAgent("my-agent", "https://api.example.com", {
      sessionId: "sess-abc",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

  return (
    <div>
      {messages.map((m, i) => (
        <p key={i}>{m.content}</p>
      ))}

      {suspension && (
        <div>
          <p>Approval required: {suspension.request.reason}</p>
          <button onClick={() => resume("approve")}>Approve</button>
          <button onClick={() => resume("reject")}>Reject</button>
        </div>
      )}

      {status !== "suspended" && (
        <form onSubmit={e => { e.preventDefault(); send(e.currentTarget.q.value); }}>
          <input name="q" disabled={status === "streaming"} />
          <button type="submit">Send</button>
          <button type="button" onClick={stop}>Stop</button>
          <button type="button" onClick={regenerate}>Regenerate</button>
        </form>
      )}
    </div>
  );
}
```

---

## API reference

### `useAgent(agentId, baseUrl?, opts?)`

Convenience wrapper. Derives the query endpoint as
`${baseUrl}/v1/agents/${agentId}/query` and the resume endpoint as
`${baseUrl}/v1/agents/${agentId}/resume`.

### `useEidenticStream(endpoint, opts?)`

Lower-level hook. Use when you manage the URL yourself.

#### Options (`EidenticStreamOptions`)

| Option | Type | Description |
|---|---|---|
| `sessionId` | `string` | Session ID. Generated client-side if omitted (SSR-safe). |
| `userId` | `string` | Deprecated browser identity; ignored unless `allowUntrustedIdentityBody` is enabled. |
| `allowUntrustedIdentityBody` | `boolean` | Unsafe legacy opt-in for body identity fields. Prefer auth headers + server-side identity. |
| `headers` | `Record<string, string>` | Extra request headers (auth tokens, etc.). |
| `initialMessages` | `TextMessage[]` | Seed the message list on mount (restore history). |
| `resumeEndpoint` | `string` | Override the resume URL. Default: query URL with `/query` replaced by `/resume`. |
| `onUpdate` | `(state) => void` | Called after every parsed event while streaming. |
| `onResult` | `(result: ResultEvent) => void` | Called when the terminal `result` event arrives. |
| `onError` | `(err: Error) => void` | Called on fetch or parse error. |
| `onEvent` | `(ev: StreamEvent) => void` | Raw-event escape hatch — called for **every** server event (tool inputs, usage/cost, compaction, suspension, `session.init`). Nothing is hidden. |

#### State (`EidenticStreamState`)

| Field | Type | Description |
|---|---|---|
| `messages` | `TextMessage[]` | Accumulated assistant messages. Each entry has `role`, `content`, and `streaming` (true while tokens are arriving). |
| `toolCalls` | `ToolCall[]` | All tool-use invocations across turns. |
| `toolResults` | `ToolResult[]` | All tool results across turns. |
| `result` | `ResultEvent \| null` | The terminal result event (`subtype: "success" \| "suspended" \| "error" \| ...`). |
| `status` | `StreamStatus` | `"idle" \| "streaming" \| "done" \| "error" \| "suspended"` |
| `error` | `Error \| null` | Set when `status === "error"`. |
| `suspension` | `SuspensionState \| null` | Set when `status === "suspended"`. Contains `callId` and `request` (reason + optional `present` payload) for rendering an approval card. |
| `send(input, opts?)` | function | Send a user message. `opts.body` merges extra fields into the POST body (tracing IDs, metadata). No-op while streaming. |
| `stop()` | function | Abort the in-flight request. |
| `resume(decision)` | function | Resume after suspension. Accepts `"approve"`, `"reject"`, a boolean, or `{ approved, data? }`; always sends the server DTO. |
| `regenerate()` | function | Fails locally with an append-only safety error; start a new/forked session explicitly instead of replaying a side-effecting turn. |
| `setMessages(msgs)` | function | Replace the message list directly — use to clear, restore, or rewrite history. |

---

## Human-in-the-loop (HITL) suspension

When an agent tool requires human approval, the server emits a terminal
`result` event with `subtype: "suspended"`. The hook surfaces this as:

- `status === "suspended"`
- `suspension.callId` — the ID of the suspended tool call
- `suspension.request.reason` — human-readable reason string
- `suspension.request.present` — opaque context payload (e.g. the file to delete, the SQL to approve)

Call `resume("approve")`, `resume("reject")`, or pass a typed `{ approved, data? }` decision
to POST `{ sessionId, decision }` to the resume endpoint and continue
streaming. The new stream output is merged with the prior accumulated history.

```tsx
function ApprovalGate() {
  if (status === "suspended" && suspension) {
    return (
      <ApprovalCard
        reason={suspension.request.reason}
        context={suspension.request.present}
        onApprove={() => resume("approve")}
        onReject={() => resume("reject")}
      />
    );
  }
  return null;
}
```

---

## Raw-event escape hatch

`onEvent` receives every `StreamEvent` the server emits, including events that
the hook does not surface in the simplified state (tool inputs, cost
breakdowns, compaction markers, `session.init`):

```ts
useEidenticStream(endpoint, {
  onEvent(ev) {
    if (ev.type === "result" && ev.cost) {
      console.log("Total cost USD:", ev.cost.usd);
    }
    if (ev.type === "compaction") {
      console.log("Compacted", ev.before, "→", ev.after, "tokens");
    }
    if (ev.type === "assistant") {
      const toolUses = ev.content.filter(b => b.type === "tool_use");
      console.log("Tool inputs:", toolUses);
    }
  },
});
```

The `parseEidenticStream` generator also exposes `ParsedStreamState.events`
(all events) and `ParsedStreamState.lastEvent` (the event that triggered each
yield) for use in pure/server-side contexts.

The parser accepts both Eidentic SSE and raw NDJSON streams. Automatic retries are limited to
failures before any response bytes arrive; a partial stream is never replayed because doing so could
duplicate agent or tool side effects.

---

## History control

```ts
// Seed conversation from persisted history.
const { setMessages } = useAgent("bot", "", {
  initialMessages: loadedHistory,
});

// Clear conversation.
const handleClear = () => {
  setMessages([]);
};
```

---

## Custom body fields

Merge per-message metadata into the POST body:

```ts
send(userInput, {
  body: {
    traceId: currentSpan.traceId,
    locale: navigator.language,
  },
});
```

---

## `parseEidenticStream` (pure parser)

For non-React environments (Node.js scripts, test harnesses, server-side
processing), the parser can be used directly:

```ts
import { parseEidenticStream } from "@eidentic/react";

const res = await fetch(endpoint, { method: "POST", body: JSON.stringify({ input }) });
for await (const state of parseEidenticStream(res.body!.getReader())) {
  state.lastEvent && console.log(state.lastEvent.type);
}
```

---

## Peer dependencies

- React >= 18
- `@eidentic/types` (workspace dependency, resolved automatically in the monorepo)
