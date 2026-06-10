---
title: Building your own UI
description: Three paths for connecting a custom frontend to a Eidentic agent — AI SDK UI ecosystem, headless hooks, and copy-paste components.
---

Eidentic has no prescribed frontend. You own the UI and you pick how deep the integration goes. There are three paths, ordered from least code to most control.

---

## Path 1 — AI SDK UI ecosystem (recommended)

`withEidentic(agent)` defaults to the AI SDK UI protocol (`protocol: "ai-sdk-ui"`). That means a Next.js route handler works directly with `useChat` from `@ai-sdk/react` and the full AI SDK UI component ecosystem — no custom adapter code required.

### Install

```bash
npm install eidentic @eidentic/nextjs @eidentic/libsql ai @ai-sdk/anthropic @ai-sdk/react
```

### Backend — one route file

```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { agent } from "@/lib/agent";

// Eidentic requires the Node.js runtime (SQLite, crypto, file I/O).
export const runtime = "nodejs";

// That's it. The default protocol is "ai-sdk-ui".
export const POST = withEidentic(agent);
```

The `withEidentic` helper reads `{ message, sessionId, userId? }` from the JSON body, calls `agent.query()`, and streams the response in AI SDK UI wire format.

### Client — `useChat`

```tsx
// app/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });

  return (
    <div>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.role}:</strong> {m.content}
          </li>
        ))}
      </ul>
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit" disabled={isLoading}>
          Send
        </button>
      </form>
    </div>
  );
}
```

### Component libraries

Because the backend speaks the AI SDK UI protocol, any component library built on that wire format works out of the box:

- **AI Elements** — accessible, unstyled primitives (`npm install ai-elements`). Components are copied into your project — you own the code.
- **assistant-ui** — opinionated chat shell (`npm install @assistant-ui/react`). Shadcn-based; run the init command and copy the components you want.

Both are copy-paste / own-the-code patterns — there is no lock-in. You swap or delete components like any other source file.

### Multi-tenant: derive identity server-side

In production, derive `userId` from your auth session inside the route, not from the request body:

```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { getServerSession } from "@/lib/auth"; // your auth helper
import { agent } from "@/lib/agent";

export const runtime = "nodejs";

export const POST = withEidentic(agent, {
  async identify(req) {
    const session = await getServerSession(req);
    if (!session) throw new Error("Unauthenticated"); // or return a 401 yourself
    return { userId: session.user.id };
  },
});
```

---

## Path 2 — Headless hooks (full control)

`@eidentic/react` ships headless hooks that give you every Eidentic event, per-turn cost, tool calls, and suspension state — you render everything yourself.

Set `protocol: "ndjson"` on the route to emit raw `StreamEvent` objects:

```ts
// app/api/chat/route.ts
export const POST = withEidentic(agent, { protocol: "ndjson" });
```

### `useAgent` and `useEidenticStream`

`useAgent` is the main hook. It targets a Eidentic server by agent ID:

```tsx
"use client";
import { useAgent } from "@eidentic/react";

export default function ChatPage() {
  // useAgent(agentId, baseUrl?, opts?)
  // Points at /v1/agents/support/query on the same origin by default.
  const { messages, status, error, send, stop } = useAgent("support");

  return (
    <div>
      {messages.map((m, i) => (
        <p key={i} style={{ opacity: m.streaming ? 0.6 : 1 }}>
          {m.content}
        </p>
      ))}
      {status === "error" && <p style={{ color: "red" }}>{error?.message}</p>}
      <button onClick={() => send("Hello!")} disabled={status === "streaming"}>
        {status === "streaming" ? "…" : "Send"}
      </button>
      {status === "streaming" && (
        <button onClick={stop}>Stop</button>
      )}
    </div>
  );
}
```

For a custom backend URL (for example, a `@eidentic/server` instance on a different origin), use `useEidenticStream` directly:

```tsx
import { useEidenticStream } from "@eidentic/react";

const { messages, send } = useEidenticStream(
  "https://agents.example.com/v1/agents/support/query",
  { headers: { authorization: "Bearer my-key" } },
);
```

### Cost surfacing

The `onEvent` callback receives every raw `StreamEvent`, including per-turn usage and the terminal `CostBreakdown`:

```tsx
"use client";
import { useEidenticStream } from "@eidentic/react";
import { useState } from "react";
import type { CostBreakdown } from "@eidentic/types";

export default function ChatWithCost() {
  const [cost, setCost] = useState<CostBreakdown | null>(null);

  const { messages, send } = useEidenticStream("/api/chat", {
    onEvent(ev) {
      if (ev.type === "result" && ev.cost) {
        setCost(ev.cost);
      }
    },
  });

  return (
    <div>
      {messages.map((m, i) => <p key={i}>{m.content}</p>)}
      {cost && (
        <p>Session cost: ${cost.usd?.toFixed(4)}</p>
      )}
      <button onClick={() => send("Hello!")}>Send</button>
    </div>
  );
}
```

### `useWorkflowRun` — workflow trace

Fetch the execution trace for a workflow run:

```tsx
import { useWorkflowRun } from "@eidentic/react";

export function WorkflowTrace({ runId }: { runId: string }) {
  const { trace, loading } = useWorkflowRun(runId, {
    baseUrl: "https://agents.example.com",
    pollIntervalMs: 2000,
  });

  if (loading) return <p>Loading…</p>;
  return (
    <ol>
      {trace.map((step) => (
        <li key={step.path.join(".")} style={{ color: step.status === "error" ? "red" : "inherit" }}>
          {step.name} — {step.durationMs}ms
        </li>
      ))}
    </ol>
  );
}
```

### `useAsyncRun` — background runs

For long-running or background jobs, fire and poll:

```tsx
import { useAsyncRun } from "@eidentic/react";

export function BackgroundJob() {
  const { start, status, output, error, isPolling } = useAsyncRun("research-agent");

  return (
    <div>
      <button
        onClick={() => start({ topic: "quantum computing" })}
        disabled={isPolling}
      >
        Start
      </button>
      <p>Status: {status}</p>
      {status === "completed" && <pre>{JSON.stringify(output, null, 2)}</pre>}
      {error && <p style={{ color: "red" }}>{error}</p>}
    </div>
  );
}
```

---

## Path 3 — `eidentic add component` (own-the-code starters)

For a fast on-brand start, the CLI can copy Tailwind v4 components directly into your project:

```bash
eidentic add component chat
eidentic add component workflow-trace
eidentic add component run-status
```

Each command writes a standalone component into `components/eidentic/`. The files become yours — edit styles, behaviour, and markup however you like. They are built on the headless hooks from `@eidentic/react` and have no hidden dependencies on Eidentic internals.

| Component | What it copies |
|---|---|
| `chat` | Full chat UI (message list, input, streaming indicator) |
| `workflow-trace` | Step-by-step execution trace viewer |
| `run-status` | Status badge and output panel for async/background runs |

Because you own the code, there is no version coupling — update Eidentic, and your component files stay unchanged until you choose to re-copy.

---

## CopilotKit interop

If your product already uses CopilotKit as the user-facing chat layer, you can point it at a Eidentic backend. CopilotKit speaks the AI SDK UI protocol on the wire, and that is exactly what `withEidentic` emits by default.

Set up a Eidentic route as you would for `useChat`, then configure CopilotKit to call it:

```ts
// app/api/copilotkit/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { agent } from "@/lib/agent";

export const runtime = "nodejs";
export const POST = withEidentic(agent); // AI SDK UI protocol — CopilotKit-compatible
```

```tsx
// app/layout.tsx
import { CopilotKit } from "@copilotkit/react-core";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <CopilotKit runtimeUrl="/api/copilotkit">
          {children}
        </CopilotKit>
      </body>
    </html>
  );
}
```

Eidentic does not bundle CopilotKit. This interop is optional — useful for teams already using it as a product layer around a backend agent.

---

## Decision guide

| Goal | Path |
|---|---|
| Fastest path to a working chat UI | AI SDK UI ecosystem (`useChat` + AI Elements or assistant-ui) |
| Render every pixel yourself, surface cost/tool state | Headless hooks (`useAgent` / `useEidenticStream`) |
| Fast on-brand start with editable components | `eidentic add component` |
| CopilotKit is already your product UI layer | Point it at the Eidentic route (AI SDK UI protocol) |

The paths are not mutually exclusive. You can start with `useChat` and later swap individual messages for headless-hook rendering when you need more control.
