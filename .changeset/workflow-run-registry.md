---
"@eidentic/workflow": minor
"@eidentic/server": minor
---

Add `WorkflowRunRegistry` to `@eidentic/workflow` and consumer-facing workflow endpoints to `@eidentic/server`.

`@eidentic/workflow` exports `createWorkflowRunRegistry({ limit? })` — a bounded in-memory ring-buffer (default 100 entries) that derives `status`, `startedAt`, `durationMs`, `stepCount`, and `error` from a `WorkflowResult` trace. Also exports `WorkflowRunRecord`, `WorkflowRunRegistry`, and `WorkflowRunRegistryOptions`.

`@eidentic/server` adds:
- `handle.recordWorkflow(name, result)` on the value returned by `createServer()` — programmatic ingestion, returns the generated record id.
- `GET /v1/workflows` — auth-gated list of run summaries `[{ id, name, status, startedAt, durationMs, stepCount }]`, newest first.
- `GET /v1/workflows/:id` — auth-gated full detail `{ id, name, status, startedAt, durationMs, stepCount, trace, output?, error? }`, 404 for unknown ids.

`createServer` now returns `EidenticServer` (a `Hono & { handle: ServerHandle }` intersection) — existing `app.request(...)` usage is unaffected.
