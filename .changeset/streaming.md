---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/model": minor
---

Token streaming: `ModelPort.stream()` (optional), `stream.delta` events from the agent loop, and `AIModel.stream()` over AI SDK v6 `streamText`. The loop prefers streaming when the model supports it and falls back to `complete()` otherwise.
