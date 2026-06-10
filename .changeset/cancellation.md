---
"@eidentic/core": minor
"@eidentic/types": minor
"@eidentic/model": minor
---

§16.4 cooperative query cancellation — `aborted` result subtype producer, checkpoint-on-abort, child teardown, model `abortSignal` forwarding.

- **`QueryOptions.signal?: AbortSignal`** (existed) is now threaded all the way through `runTurn` → `runLoop` via the new `RunTurnArgs.signal` field, closing the gap where a long model call or the loop itself would never stop on abort.
- **Loop boundary checks:** `signal?.aborted` is tested at three points per turn — (1) top of the turn before the model call, (2) immediately after the model call + usage accounting, (3) after each tool batch. On abort the loop emits a terminal `result{subtype:"aborted"}` with the partial `usage`/`cost` accumulated so far and returns.
- **Checkpoint-on-abort:** when `durable` mode is on, `writeCheckpoint` is called before emitting the `aborted` terminal, reusing the existing incremental rolling-hash mechanism so the aborted run is auditable and resumable.
- **Mid-model-call abort:** `args.signal` is forwarded to the model request as `ModelRequest.signal` (new optional field on `@eidentic/types` `ModelRequest`). `AIModel.complete`/`stream` in `@eidentic/model` pass it to AI SDK v6 `generateText`/`streamText` as `abortSignal`. For the stream path, the delta iteration `break`s when `signal.aborted`; if no final response was accumulated, an `aborted` terminal is emitted rather than an error.
- **Child teardown:** `buildSpawnTool` now accepts an optional `signal` argument (captured from `runReact`'s `opts.signal`) and threads it into each child `agent.query(input, { ..., signal })` so the entire sub-agent tree aborts cooperatively with the same semantics.
- **No-signal path byte-identical:** all boundary checks are `signal?.aborted` which is `undefined`→falsy when no signal is supplied; zero overhead for callers that do not pass a signal.
