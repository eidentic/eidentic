---
"@eidentic/studio": minor
---

Add workflow trace visualization to Studio.

Introduces an in-memory workflow-run registry (bounded to last 100 runs) in the Studio API and a new Workflows view in the UI.

API (`createStudioApi` / `createStudio` now return `StudioHandle` — a Hono instance extended with `recordWorkflow`):
- `handle.recordWorkflow(name, workflowResult)` — programmatically record a completed workflow run; derives status and timing from the trace
- `GET /api/workflows` — list recorded runs (id, name, status, startedAt, durationMs, stepCount)
- `GET /api/workflows/:id` — full run detail including the complete step trace and output
- `POST /api/workflows` — HTTP ingestion endpoint (auth-gated) for recording runs from a separate process

UI (`WorkflowsView`):
- Sidebar nav entry "Workflows" (not agent-scoped — shows all recorded runs)
- Left panel lists runs with name, status badge, duration, step count
- Right panel renders the step trace as a vertical sequence indented by `StepTrace.path` depth, each row showing name, ok/error badge, duration, and error message on failure
- Output JSON shown collapsed below the trace
- Empty state with hint: `studio.recordWorkflow(name, await wf.run(input))`
