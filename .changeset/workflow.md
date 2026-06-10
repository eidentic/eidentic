---
"@eidentic/workflow": minor
---

Add `@eidentic/workflow` — type-safe, composable workflow primitives for orchestrating multi-step agent pipelines.

**Core primitives:**
- `step(name, fn)` — names a step for tracing; emits `step.start` / `step.finish` / `step.error` events and records a `StepTrace` entry
- `chain(a, b, ...)` — sequential pipe with typed overloads for 2–8 steps; output of each feeds the next; zero-annotation inference flows A→…→last
- `parallel({ key: step, ... })` — runs all steps concurrently on the same input; returns a typed record of results; any rejection surfaces which keys failed
- `branch(predicate, ifTrue, ifFalse)` — conditional routing; supports async predicates
- `retry(inner, { maxAttempts, backoffMs?, shouldRetry? })` — retries on failure with optional backoff; AbortError is never retried
- `fallback(primary, ...fallbacks)` — tries each step in order until one succeeds; AbortError propagates immediately
- `withTimeout(inner, ms)` — races the step against a timeout; aborts the inner step via a linked signal when the timeout fires
- `map(inner, { concurrency? })` — runs a step over each array element with bounded concurrency (default 4), preserving output order
- `tap(fn)` — side-effect passthrough; returns input unchanged

**Agent adapter:**
- `agentStep(agent, { toInput?, fromOutput?, sessionId? })` — wraps an `Agent` as a `Step`; drains `agent.query()` to the terminal result event; a non-success terminal throws so retry/fallback can catch it; forwards the step signal

**Workflow runner:**
- `workflow(name, body)` — creates a named `Workflow<I,O>`; `run(input, { signal?, onEvent? })` returns `{ output, trace }`; `asStep()` exposes the workflow as a composable `Step` with path nesting
