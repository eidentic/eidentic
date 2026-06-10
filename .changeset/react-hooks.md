---
"@eidentic/react": minor
---

Complete `@eidentic/react` hook surface — zero gaps for any chat UI.

**New capabilities in `useEidenticStream` / `useAgent`:**

- **`resume(decision)`** — resumes a suspended (HITL) turn. POSTs `{ sessionId, decision }` to the resume endpoint and continues streaming into the same accumulated message state. `status` transitions through `"suspended" → "streaming" → "done"`. The `suspension` field (`{ callId, request }`) is always populated when `status === "suspended"` so UIs can render an approval card without any extra parsing.
- **`regenerate()`** — re-sends the last user input as a new turn (clears messages/toolCalls/toolResults/result first).
- **`initialMessages` opt** — seed the conversation on mount (restore from history, pre-populate).
- **`setMessages(msgs)`** — imperative setter to replace the message list (clear, restore, or rewrite history at any time).
- **`send(input, { body? })`** — `opts.body` merges extra fields into the POST body (per-message metadata, tracing, etc.).
- **`onEvent(ev: StreamEvent)`** callback — raw-event escape hatch; fires for EVERY server-emitted event (tool inputs, usage/cost, compaction, suspension, `session.init`) so no information is hidden. Also exposed as `events: StreamEvent[]` on `ParsedStreamState`.
- **`status: "suspended"`** — new status value; `StreamStatus = "idle" | "streaming" | "done" | "error" | "suspended"`.
- **`SuspensionState`** — exported type `{ callId: string; request: SuspendRequest }`.
- **`resumeEndpoint` opt** — override the resume URL (default: derived from query endpoint by replacing `/query` → `/resume`).
- **`useAgent`** — auto-derives the resume endpoint as `${baseUrl}/v1/agents/:id/resume`.
- **Parser** — `ParsedStreamState` now includes `events: StreamEvent[]` (all events) and `lastEvent: StreamEvent | null` (the triggering event for each yield). Informational events (`session.init`, `compaction`) now always yield a state update so `onEvent` consumers see them.

**Breaking:** `session.init` now yields a state update (previously silently dropped). Any code asserting `states.length === 0` after a `session.init` only event needs updating.

**README added** — documents two integration paths: (a) `useEidenticStream`/`useAgent` hooks for custom UIs, (b) using Vercel AI SDK `useChat` or CopilotKit directly against a Eidentic backend via `toUIMessageStreamResponse` (consumers are not locked into our hooks or our UI).
