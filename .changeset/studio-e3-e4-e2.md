---
"@eidentic/studio": patch
---

Studio: causal trace timeline, chat-bubble mode, memory userId filter, compaction events, HITL approval card.

**Trace / reasoning timeline** (`SessionsView`): adds a "Timeline" tab alongside the existing "Raw" events tab. The timeline renders stored events as a readable causal narrative — `user → assistant(text + tool call(args)) → tool result(output) → assistant(text) → done` — parsing `event.kind`/`event.payload` correctly (`assistant` payload = `{content: ContentBlock[]}`, `tool_result` payload = `{callId, toolName, output}`). Tool call args are collapsible; long tool outputs are expandable. Usage (in/out/cached tokens) is shown on assistant nodes. The result node surfaces turns, usage, and USD estimate.

**Chat-bubble mode** (`RunView`): a "Chat bubbles" checkbox toggles between the existing console/log mode and a chat UI where user messages appear on the right (accent bubble), assistant messages on the left (dark bubble), and tool calls/results collapse into subtle inline rows. Compaction events appear as a centered info pill in both modes.

**Memory userId filter** (`MemoryView`): a "Scope" card with a User ID text input lets the developer switch between agent-scope (blank) and user-scope memory. The filter applies to blocks, facts, and memory search queries. The studio server already accepted `userId` on all three endpoints; this wires the UI to pass it.

**Compaction events in Run view**: `compaction` stream events are now surfaced as a subtle italic row (console mode) or a centered pill (bubble mode) instead of being silently dropped.

**HITL approval card** (`RunView`): when a `result` event carries `subtype === "suspended"`, an approval card appears above the input with "Approve" and "Reject" buttons. Each calls `POST /v1/agents/:id/resume` with `{ sessionId, decision: "approve"|"reject" }`, then shows confirmation inline and dismisses the card.
