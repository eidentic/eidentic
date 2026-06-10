---
"@eidentic/core": minor
---

Add **composable agent strategies** (§3.6): reasoning patterns layered over the same ReAct loop, not separate loops.

Three strategies ship:

- **`react()`** — default passthrough. When no `strategy` is configured, behavior is byte-identical to today (the existing loop, unchanged). `react()` is the explicit form of the same default.
- **`reflection({ critic, maxRevisions?, ground? })`** — draft → critic → revise wrapper. The base ReAct loop produces a draft; a CRITIC model (a distinct `ModelPort` — Constitution #6: intrinsic self-critique fails) evaluates it via a structured `critique` tool call (`{ satisfactory, feedback }`). If unsatisfactory, the loop re-enters with the critic's feedback in context, up to `maxRevisions` times. Optional `ground` signals (external validators, e.g. test runners, schema checkers) are called per draft and their reports fed into the critic's prompt so critique is grounded, not vibes. Robust: malformed critic output → fail-safe accept; loop always terminates. The stream emits exactly ONE terminal `result` — the accepted draft.
- **`planAndExecute({ planner, executor?, replanEvery?, maxSteps? })`** — a PLANNER model produces a typed step list (`make_plan` tool), each step runs as a ReAct sub-run optionally on a cheaper EXECUTOR model (structurally "1× strong planner + N× cheap executor"). Replanning gate: re-plan after `replanEvery` steps or on step failure, capped by `maxSteps`. Robust against empty plans (fallback to single react run) and malformed planner output. The stream emits exactly ONE terminal `result` synthesizing all step outputs.

**Public API:**
```ts
new Agent({ strategy: reflection({ critic: opusModel, ground: [myTestRunner], maxRevisions: 2 }) })
new Agent({ strategy: planAndExecute({ planner: opusModel, executor: haikuModel, replanEvery: 5 }) })
new Agent({ /* ... */ })  // no strategy = react() default — byte-identical
```

`resume()` always uses the plain react path for v1 (strategies are forward-run only).

New exports from `@eidentic/core`: `react`, `reflection`, `planAndExecute` (functions), `AgentStrategy`, `StrategyContext`, `GroundSignal` (types).
