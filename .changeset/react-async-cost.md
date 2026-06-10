---
"@eidentic/react": minor
---

Add async-run hooks, workflow hooks, and cost/usage surfacing to @eidentic/react.

**Feature 1 — `useAsyncRun` / `useRunStatus` (fire-and-poll):**
- `useAsyncRun(agentId, opts?)` → `{ start(input, { sessionId? }): Promise<{runId}>; runId; status; output; error; isPolling }`. POSTs to `POST /v1/agents/:id/runs`, then polls `GET /v1/agents/:id/runs/:runId/status` every `pollIntervalMs` (default 1500ms) until the status is terminal (`completed` / `failed` / `aborted`). Cleans up the poll on unmount and when a new run starts.
- `useRunStatus(agentId, runId | null, opts?)` → `{ status; output; error; isPolling }`. Polls an already-existing run ID until terminal. Stops on unmount or when `runId` changes.
- Both respect `AbortController` for cancellation; polling stops immediately on terminal or unmount.

**Feature 2 — `useWorkflowList` / `useWorkflowRun`:**
- `useWorkflowList(opts?)` → `{ runs; loading; error; refresh() }`. Fetches `GET /v1/workflows` (newest-first list). Supports optional `pollIntervalMs` for live refresh.
- `useWorkflowRun(id | null, opts?)` → `{ run; trace; loading; error; refresh() }`. Fetches `GET /v1/workflows/:id` detail including `StepTrace[]`. Supports optional polling.
- New types exported: `StepTrace`, `WorkflowRunSummary`, `WorkflowRunDetail`, `WorkflowOptions` — plain interfaces, no dependency on `@eidentic/workflow`.

**Feature 3 — Cost/usage surfacing in the stream parser:**
- `ParsedStreamState` gains three new fields: `usage: Usage` (cumulative, updated from assistant events; replaced by the authoritative total on the terminal `result` event), `turnUsages: TurnUsage[]` (per-turn snapshots from assistant events), and `cost: CostBreakdown | null` (populated from the terminal `result` event's `cost` field).
- `ResultEvent` gains an optional `cost?: CostBreakdown` field.
- `TurnUsage` interface exported: `{ turn: number; usage: Usage }`.
- All changes are additive (backward compatible).
