---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/core": minor
---

Human-in-the-loop durable suspension (§5.7 / §9.4). A tool can `await ctx.suspend({ reason, present })` to pause a run for human input/approval: the run persists and consumes NO compute while waiting, yields a terminal `subtype: "suspended"` result carrying the request + callId, and later `agent.resume(sessionId, { decision })` records the decision and continues — the suspended tool re-runs and `ctx.suspend` returns the injected `{ approved, data? }`, so the tool's real side effect runs EXACTLY ONCE behind that gate. Built on the Plan 9a durable substrate: new `DurablePort.recordDecision`/`getDecision` (keyed by `(sessionId, callId)`) implemented by `InMemoryStore` + `SqliteStore` (new migration v7 `suspension_decisions`), covered by `durableConformanceCases`. The loop appends a `"suspension"` audit event (ignored on replay, like `compaction`) and folds it into the rolling checkpoint hash; `ctx.suspend` requires durable execution (clear error otherwise), and a suspending tool produces no tool_result (the `SuspendSignal` is propagated to the loop, never swallowed into a tool error). Complements the Plan 10 permission "ask" gate. Deferred: cryptographic/passkey approval UX (§10.5), a hosted approval queue/notification system, multi-party approvals, and timeout/auto-deny policies.
