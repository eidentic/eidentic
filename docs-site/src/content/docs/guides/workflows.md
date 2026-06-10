---
title: Workflows
description: Build multi-step pipelines with @eidentic/workflow — chain, parallel, suspend/resume, durable run store.
---

`@eidentic/workflow` lets you compose typed async pipelines from small reusable steps. It is separate from the agent runtime: workflows orchestrate any async logic, and an `agentStep` adapter makes an `Agent` a drop-in step.

## Install

```bash
npm install @eidentic/workflow
```

## The basics: `step`, `chain`, `workflow`

A `Step<I, O>` is `(input: I, ctx: StepContext) => Promise<O>`. The `step()` helper gives a plain function a name for tracing:

```ts
import { step, chain, workflow } from "@eidentic/workflow";

const fetch = step("fetch", async (url: string) => {
  const res = await globalThis.fetch(url);
  return res.text();
});

const summarise = step("summarise", async (html: string) => html.slice(0, 500));

const wf = workflow("page-summary", chain(fetch, summarise), { version: "1.0.0" });

const { output, trace } = await wf.run("https://example.com");
console.log(output); // first 500 chars
```

### Fluent builder

```ts
const wf = workflow("triage", { version: "2.1.0" })
  .step(classify)              // Step<Ticket, Category>
  .branch(c => c === "billing", billing, tech);
```

### Imperative body with `ctx`

```ts
const wf = workflow("research", async (query: string, { step, all }) => {
  const [web, kb] = await Promise.all([
    step("web", webSearch, query),
    step("kb", kbSearch, query),
  ]);
  return step("synthesise", synthesise, { web, kb });
});
```

`ctx.step(name, fn, input?)` records the step in the trace and memoizes it for suspend/resume replay.

`ctx.all(thunks)` runs a record of thunks concurrently — the imperative equivalent of `parallel()`.

## Combinators

| Combinator | Signature | Description |
|---|---|---|
| `chain(...steps)` | `Step<First, Last>` | Sequential pipeline; typed adjacency checked at compile time |
| `parallel(steps)` | `Step<I, { [K]: O }>` | All steps run concurrently on the same input; all-or-nothing |
| `branch(pred, ifTrue, ifFalse)` | `Step<I, O>` | Conditional dispatch |
| `retry(step, opts)` | `Step<I, O>` | Retry with back-off; `maxAttempts`, `backoffMs`, `shouldRetry` |
| `fallback(primary, ...fallbacks)` | `Step<I, O>` | Try each in order; stops on first success |
| `withTimeout(step, ms)` | `Step<I, O>` | Race against a timeout; links to parent AbortSignal |
| `map(step, opts?)` | `Step<I[], O[]>` | Bounded-concurrency fan-out; `concurrency` defaults to 4 |
| `tap(fn)` | `Step<I, I>` | Side-effect without changing the value |

### `map` error policies

```ts
import { map } from "@eidentic/workflow";

// fail-fast (default) — stops on first error, throws MapError
const pipeline = map(processItem);

// collect — runs every item, returns MapItemResult<O>[]
const safe = map(processItem, { errorPolicy: "collect", concurrency: 8 });
const results = await safe(items, ctx);
for (const r of results) {
  if (r.ok) console.log(r.value);
  else console.error(r.error);
}
```

`MapError.errors` is `ReadonlyArray<{ index: number; error: unknown }>` — all failures, not just the first.

### Per-step retry

```ts
// Via the retry() combinator
const resilient = retry(callApi, { maxAttempts: 3, backoffMs: 500 });

// Via ctx.step options (imperative body)
const result = await ctx.step("call-api", callApi, input, {
  retry: { maxAttempts: 3, backoffMs: 500, shouldRetry: (e) => isTransient(e) },
});
```

## Suspend / Resume (Human-in-the-loop)

`ctx.suspend(token, payload?)` pauses the run at a named gate. The run body re-executes deterministically on resume.

```ts
const wf = workflow("approve-draft", async (ticket, { step, suspend }) => {
  const draft = await step("draft", generateDraft, ticket);
  // Run suspends here; payload is available to the approver
  const approved = await suspend<boolean>("approve", draft);
  if (!approved) return { status: "rejected" };
  return step("send", sendEmail, draft);
});
```

### Determinism contract

When the workflow resumes, the **entire body re-runs from the top**. Any code before a `suspend` gate runs again on every resume. Keep all side effects inside `ctx.step(...)` — those results are memoized and the functions are NOT re-invoked on replay.

Rules:
- Every network call, DB write, random value, `Date.now()` → inside `ctx.step(name, fn)`.
- Control flow (branches, loops) before a suspend must depend only on the original input or on memoized step results.
- Step names must be stable and unique enough that the `name + occurrence-index` key is consistent across replays.

### Catch the suspension signal

```ts
import { isWorkflowSuspended, WorkflowSuspended } from "@eidentic/workflow";

try {
  const result = await wf.run(input);
  // completed
} catch (e) {
  if (isWorkflowSuspended(e)) {
    const s = e as WorkflowSuspended;
    console.log("Waiting for approval of token:", s.token);
    console.log("Payload:", s.payload);
    // Persist s.cache + s.token + the original input for resumeWorkflow()
  }
}
```

### Resume

```ts
import { resumeWorkflow, createWorkflowRunRegistry, fileWorkflowRunStore } from "@eidentic/workflow";

const registry = createWorkflowRunRegistry({
  store: fileWorkflowRunStore("./workflow-runs.json"),
});
await registry.hydrate(); // load persisted runs on startup

const result = await resumeWorkflow(wf, runId, {
  registry,
  decision: true, // the approval value fed into suspend<boolean>()
});

if (result.kind === "completed") {
  console.log("Done:", result.output);
} else if (result.kind === "suspended") {
  console.log("Suspended again at:", result.token);
} else {
  console.error("Error:", result.error);
}
```

## Durable run store and registry

The `WorkflowRunRegistry` keeps an in-memory ring buffer (default 100 entries) and optionally writes through to a `WorkflowRunStore`.

```ts
import { createWorkflowRunRegistry, fileWorkflowRunStore } from "@eidentic/workflow";

const registry = createWorkflowRunRegistry({
  limit: 500,
  store: fileWorkflowRunStore("./data/runs.json"), // crash-safe atomic rename
  onStoreError: (err, rec) => console.error("Failed to persist run", rec.id, err),
});

await registry.hydrate(); // call once on startup to load from disk
```

`fileWorkflowRunStore` writes the full snapshot to `<path>.tmp` then renames atomically — a crash never leaves a partially-written file.

### Recording runs

```ts
const result = await wf.run(input);
const record = registry.record(wf.name, result, { userId: "u-42" });
console.log("Run id:", record.id);
```

### Filtering

```ts
const suspended = registry.list({ runStatus: "suspended" });
const v2runs = registry.list({ version: "2.0.0", owner: { userId: "u-42" } });
```

`runStatusOf(record)` is a safe helper that resolves the full lifecycle status for both new and legacy records.

## Versioning

Pass `version` to tag every run:

```ts
const wf = workflow("pipeline", body, { version: "1.2.3" });
```

Version is stored on `WorkflowRunRecord.version` and filterable via `registry.list({ version: "1.2.3" })`.

## Server endpoints

When using `@eidentic/server`, inject your registry to expose workflow runs over HTTP:

```ts
import { createServer } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  workflowRuns: registry,
});
```

| Route | Description |
|---|---|
| `GET /v1/workflows` | List run summaries (newest first) |
| `GET /v1/workflows/:id` | Full run detail with trace, output, error |

Use `handle.recordWorkflow` / `handle.recordWorkflowError` to ingest runs produced outside the server:

```ts
const { app, handle } = createServer({ ... });
const result = await wf.run(input);
handle.recordWorkflow(wf.name, result, { userId: principal.userId });
```

## Error types

| Class | When |
|---|---|
| `WorkflowRunError` | The workflow body threw; carries `.trace` of partial steps |
| `MapError` | `map()` fail-fast mode; `.errors` has all failed indices |
| `WorkflowSuspended` | Not an error — normal control-flow signal for HITL gates |

## Gotchas

- `isWorkflowSuspended` uses a structural brand check, not `instanceof`, so it works across module boundaries.
- `retry()` and `fallback()` never swallow a `WorkflowSuspended` — suspension propagates immediately.
- `withTimeout` links to the parent `signal` so parent cancellation is always respected.
- The file store serializes all writes through a promise chain — concurrent `save()` calls are safe.
