---
"@eidentic/core": minor
---

Structured output (`outputSchema`, D2) now works with reasoning **strategies** and **`resume()`** — closing the v1 limitation where it only applied to the default ReAct path.

- **Strategies + `outputSchema`**: when a `strategy` is set and `query({ outputSchema })` is given, the schema constrains ONLY the strategy's FINAL answer. Intermediate react sub-runs run UNCONSTRAINED (reflection's draft/critique passes; planAndExecute's per-step runs), so they can still call tools and emit free text. After the strategy produces its accepted free-text answer, ONE final schema-constrained react sub-run renders it as the typed object, surfaced as `result.object` on the single terminal event. The `react()` passthrough strategy applies the schema to its single (final) run, as before.
- **`resume({ outputSchema })`**: `resume()` now accepts an `outputSchema` and threads it into the resumed run's react path, so a resumed run also yields `result.object`. Resuming an already-terminated session validates the stored final text against the schema and attaches the parsed object (a mismatch terminates with `subtype: "error"`).

Fully backward-compatible: omitting `outputSchema` leaves both the strategy and resume paths byte-identical.
