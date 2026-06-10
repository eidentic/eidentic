---
"@eidentic/eval": minor
---

Add `promoteTraceToEvalCase` and `collectPromotedCases` — trace promotion API for closing the prod→eval loop.

**`promoteTraceToEvalCase(events, opts?): DatasetCase`** — turns a captured production trace (`StoredEvent[]`) into an `EvalCase` the existing runner and scorers can execute directly. Extracts the user input from the first `user` event and the observed final assistant text as a regression baseline in `groundTruth` (`useObservedAsBaseline: true` by default — set `false` to leave it blank for human labeling). Provenance is recorded on `DatasetCase.meta` (`sourceRunId`, `promotedAt`, `tags`); the original events are preserved in `capturedEvents` for replay/inspection. Throws a descriptive error on an empty or non-array trace so callers fail fast.

**`collectPromotedCases(name, cases): EvalDataset`** — assemble multiple promoted cases into an `EvalDataset` ready for `evaluate()`.

**`DatasetCase.meta`** — new optional field (`Record<string, unknown>`) for arbitrary provenance metadata; transparent to the runner/scorers and round-trips cleanly through `saveDatasetJsonl` / `loadDatasetJsonl`.

Pure/in-memory and store-agnostic — input is a trace array, output is an `EvalCase`. Persistence is left to the caller.
