---
title: React Hooks Reference
description: useEidenticStream, useAsyncRun, useRunStatus, useWorkflowList, useWorkflowRun — props, returns, and examples.
---

`@eidentic/react` provides five hooks that cover streaming chat, fire-and-poll async runs, and workflow inspection.

## Install

```bash
npm install @eidentic/react
```

All hooks are `"use client"` components.

---

## `useEidenticStream`

Streaming chat hook. Connects to an agent's `/query` endpoint and manages the full message lifecycle.

```ts
import { useEidenticStream } from "@eidentic/react";

function Chat() {
  const { messages, status, send, stop } = useEidenticStream(
    "/v1/agents/support/query",
    { sessionId: "sess-123", userId: "user-42" }
  );

  return (
    <div>
      {messages.map(m => <p key={m.id}>{m.text}</p>)}
      <button onClick={() => send("Hello")} disabled={status === "streaming"}>
        Send
      </button>
      {status === "streaming" && <button onClick={stop}>Stop</button>}
    </div>
  );
}
```

### Options (`EidenticStreamOptions`)

| Option | Type | Description |
|---|---|---|
| `sessionId` | `string` | Pre-existing session id. If omitted, generated lazily (SSR-safe). |
| `userId` | `string` | Forwarded in the POST body for per-user memory recall. |
| `headers` | `Record<string, string>` | Extra request headers (e.g. `Authorization`). |
| `initialMessages` | `TextMessage[]` | Pre-populate the conversation on mount. |
| `resumeEndpoint` | `string` | Override the resume URL (default: derived from query URL). |
| `onUpdate` | `(state) => void` | Called on every stream event. |
| `onResult` | `(result) => void` | Called when the terminal result event arrives. |
| `onError` | `(err) => void` | Called on stream failure. |
| `onEvent` | `(ev) => void` | Raw escape hatch: called for every `StreamEvent`. |
| `retryOnError` | `{ attempts, backoffMs? }` | Auto-retry transient network failures. Does NOT retry terminal result events. |

### Returns (`EidenticStreamState`)

| Field | Type | Description |
|---|---|---|
| `messages` | `TextMessage[]` | Accumulated assistant text messages |
| `toolCalls` | `ToolCall[]` | Tool calls made during the turn |
| `toolResults` | `ToolResult[]` | Tool results returned |
| `result` | `ResultEvent \| null` | Terminal result event |
| `status` | `StreamStatus` | `"idle" \| "streaming" \| "done" \| "error" \| "suspended"` |
| `error` | `Error \| null` | Last stream error |
| `suspension` | `SuspensionState \| null` | When `status === "suspended"`, holds `callId` and `request` |
| `send(input, opts?)` | function | Start a new turn |
| `stop()` | function | Abort an in-flight stream |
| `resume(decision)` | function | Resolve a suspension; only valid when `status === "suspended"` |
| `regenerate()` | function | Re-send the last input |
| `setMessages(msgs)` | function | Directly replace the messages array |

### Handling suspension

```ts
const { status, suspension, resume } = useEidenticStream(endpoint, opts);

if (status === "suspended" && suspension) {
  return (
    <ApprovalCard
      request={suspension.request}
      onApprove={() => resume("approve")}
      onReject={() => resume("reject")}
    />
  );
}
```

### Auto-retry

```ts
const state = useEidenticStream(endpoint, {
  retryOnError: { attempts: 3, backoffMs: 500 }, // 500 ms, 1 s, 2 s
});
```

Only network-level failures are retried. If the server sends a terminal `result` event, that is the real agent output and is never retried.

---

## `useAsyncRun`

Fire-and-poll hook for async agent runs (`POST /v1/agents/:id/runs`). Useful when the run may take longer than a browser tab's connection lifetime.

```ts
import { useAsyncRun } from "@eidentic/react";

function BulkJob() {
  const { start, status, output, error, isPolling } = useAsyncRun<{ summary: string }>(
    "research",
    { baseUrl: "", pollIntervalMs: 2000, maxPollMs: 60_000 }
  );

  return (
    <button onClick={() => start("Summarise Q3 metrics")} disabled={isPolling}>
      Start
    </button>
  );
}
```

### Options (`AsyncRunOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | `""` | Base URL prepended to API routes |
| `headers` | `Record<string, string>` | `{}` | Extra request headers |
| `pollIntervalMs` | `number` | `1500` | How often to poll the status endpoint |
| `maxPollMs` | `number` | — | Total timeout from POST through polling. Transitions to `"failed"` with `"Run timed out"` when exceeded. |

### Returns (`UseAsyncRunReturn<TOutput>`)

| Field | Type | Description |
|---|---|---|
| `start(input, opts?)` | `async (input, { sessionId? }) => { runId }` | Start a new run |
| `runId` | `string \| null` | Current run id |
| `status` | `AsyncRunStatus` | `"idle" \| "running" \| "completed" \| "failed" \| "aborted"` |
| `output` | `TOutput \| null` | Typed output when completed |
| `error` | `string \| null` | Error message when failed |
| `isPolling` | `boolean` | True while actively polling |

---

## `useRunStatus`

Poll a known run id until terminal. Use when you already have a `runId` from a previous call or from a server-side response.

```ts
import { useRunStatus } from "@eidentic/react";

function RunProgress({ runId }: { runId: string }) {
  const { status, output, error } = useRunStatus("research", runId, {
    pollIntervalMs: 2000,
  });

  if (status === "completed") return <p>Done: {String(output)}</p>;
  if (status === "failed") return <p>Error: {error}</p>;
  return <p>Running…</p>;
}
```

### Options

Same `AsyncRunOptions` as `useAsyncRun`. `maxPollMs` is not supported (omit it; pass `pollIntervalMs` only).

### Returns (`UseRunStatusReturn<TOutput>`)

`status`, `output`, `error`, `isPolling` — same types as `useAsyncRun` minus `start` and `runId`.

---

## `useWorkflowList`

Fetch the list of recent workflow runs from `GET /v1/workflows`.

```ts
import { useWorkflowList } from "@eidentic/react";

function WorkflowDashboard() {
  const { runs, loading, error, refresh } = useWorkflowList({
    pollIntervalMs: 5000, // auto-refresh every 5 s
  });

  return (
    <ul>
      {runs.map(r => (
        <li key={r.id}>{r.name} — {r.status} ({r.durationMs} ms)</li>
      ))}
    </ul>
  );
}
```

### Returns (`UseWorkflowListReturn`)

| Field | Type | Description |
|---|---|---|
| `runs` | `WorkflowRunSummary[]` | Summaries: `id`, `name`, `status`, `startedAt`, `durationMs`, `stepCount` |
| `loading` | `boolean` | True during fetch |
| `error` | `string \| null` | Fetch error |
| `refresh()` | function | Manually trigger a re-fetch |

---

## `useWorkflowRun`

Fetch the full detail of a single workflow run from `GET /v1/workflows/:id`.

```ts
import { useWorkflowRun } from "@eidentic/react";

function RunDetail({ runId }: { runId: string }) {
  const { run, trace, loading } = useWorkflowRun(runId);

  if (loading) return <p>Loading…</p>;
  if (!run) return null;

  return (
    <div>
      <p>Output: {JSON.stringify(run.output)}</p>
      <ul>
        {trace.map(s => (
          <li key={s.name}>{s.name} — {s.durationMs} ms ({s.status})</li>
        ))}
      </ul>
    </div>
  );
}
```

Pass `null` as the id to suspend fetching (the hook resets to the empty state).

### Returns (`UseWorkflowRunReturn`)

| Field | Type | Description |
|---|---|---|
| `run` | `WorkflowRunDetail \| null` | Full record incl. `trace`, `output`, `error` |
| `trace` | `StepTrace[]` | Shorthand for `run?.trace ?? []` |
| `loading` | `boolean` | True during fetch |
| `error` | `string \| null` | Fetch error |
| `refresh()` | function | Manually trigger a re-fetch |

---

## Shared options (`WorkflowOptions`)

| Option | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Base URL (default `""`) |
| `headers` | `Record<string, string>` | Extra request headers |
| `pollIntervalMs` | `number` | When set, the hook refetches at this interval (in ms) |

## Gotchas

- All hooks clean up in-flight requests on unmount — no setState-after-unmount warnings.
- `useWorkflowList` and `useWorkflowRun` abort the previous in-flight request before each polling tick to prevent last-writer-wins state corruption.
- `useAsyncRun`'s `start()` aborts any previous run's poll loop before starting a new one.
