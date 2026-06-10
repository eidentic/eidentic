---
"@eidentic/workflow": minor
---

Add two ergonomic DX layers on top of the existing functional combinator engine — all three styles share one trace engine and produce identical `StepTrace` output.

**Layer 1 — Fluent builder** (`workflow(name)` with no body):

```ts
const wf = workflow("triage")
  .step(classify)                                         // pins In=string, Cur=string
  .branch(c => c === "billing", billing, retry(tech, { maxAttempts: 2 }))
  .parallel({ summary: summarize, sentiment: analyze }); // Cur = { summary: string; sentiment: string }

const { output } = await wf.run(ticket);
```

`WorkflowStart.step<A,B>()` pins the input type; each subsequent builder method threads `Cur` through the type system with zero annotations. Available methods: `.step()` (named/anonymous), `.branch()`, `.parallel()`, `.map()` (only callable when `Cur` is `E[]`), `.tap()`. Terminal: `.run()`, `.asStep()`, `.build()`. The builder compiles to `chain()` internally.

`retry`, `fallback`, and `withTimeout` wrap individual steps passed in — they are not builder methods.

**Layer 2 — Imperative escape-hatch** (enriched `StepContext`):

```ts
const wf = workflow("triage", async (ticket: string, { step, all }) => {
  const kind = await step("classify", classify, ticket);
  const handled = kind === "billing"
    ? await step("billing", billing, ticket)
    : await step("tech", retry(tech, { maxAttempts: 2 }), ticket);
  return all({
    summary: () => step("summary", summarize, handled),
    sentiment: () => step("sentiment", analyze, handled),
  });
});
```

`ctx.step(name, thunk)` and `ctx.step(name, step, input)` run traced units; `ctx.all(thunks)` runs concurrent thunks with a typed result object. Both delegate to the same `step()` wrapper as the declarative path.
