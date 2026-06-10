---
"@eidentic/core": minor
---

Feature 1 — Model fallback chain: `AgentConfig.modelFallback?: ModelPort[]` — when the primary model fails after exhausting `modelRetry`, each fallback is tried in order on both `complete()` and `stream()` paths. AbortError never triggers fallback. Streaming fallback only fires before the first delta is emitted. All models failing surfaces the last error.

Feature 2 — Structured-output validation retry: `AgentConfig.structuredOutputRetry?: { maxAttempts: number }` — when `outputSchema` is set and the model's final answer fails schema validation, a corrective user message is appended and the model is re-called up to `maxAttempts` additional times. Default: ON with `maxAttempts: 2`. Set `{ maxAttempts: 0 }` to disable.

Fix 3 — `Agent.eraseScope` JSDoc: removed "atomic" and documented the real best-effort fan-out semantics (store/vector/graph each attempted with per-subsystem try/catch; aggregate error thrown on partial failure; re-runnable to retry).

Fix 4 — `StrategyContext._internalOpts` is now optional (`_internalOpts?: InternalQueryOptions`) with a "do not set" doc note, so custom strategy authors are not required to populate internal plumbing fields. Internal callers fall back to `ctx.opts` when absent.

Fix 5 — `ToolContext.scope` now has a JSDoc explaining when it is populated (set by the registry within a scoped run; `undefined` in unit tests or bare `ToolRegistry` usage) so custom-tool authors avoid cryptic undefined errors.
