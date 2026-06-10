---
"@eidentic/server": minor
---

Add `BatchRunner` — bounded-concurrency offline batch processing for agent inputs.

`BatchRunner` accepts an array of `BatchItem` inputs and processes them through an
agent with a configurable concurrency cap (default 4). Features:

- **Error isolation**: a failing item is captured as `{ status: "error" }` and the
  batch continues — one bad item never aborts the whole run.
- **Aggregate usage/cost**: reuses `Usage` + `CostBreakdown` from `@eidentic/types`;
  sums `inputTokens`, `outputTokens`, and USD across all successful items.
- **AbortSignal cancellation**: once the signal fires, no further items are dispatched;
  in-flight items receive the signal; `aggregate.cancelled` is set to `true`.
- **Progress callback**: `onProgress(item)` is invoked once per completed item
  (success or error) for streaming partial results to a UI or disk.
- **Provider-native batch seam**: a `BatchBackend` strategy interface allows a future
  Anthropic Message Batches or OpenAI Batch API adapter to slot in without changing
  the public `BatchRunner` API. v1 uses `agent.query()` directly with bounded
  parallelism (provider-native batch deferred — AI SDK v6 does not expose the
  provider REST batch APIs cleanly).
