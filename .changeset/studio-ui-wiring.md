---
"@eidentic/studio": patch
"@eidentic/cli": patch
---

Fix studio UI→API wiring bugs found by audit:

- **B1 (blocker):** Run console now renders tool results — event name was `tool_result` (wrong) and field was `content` (wrong); fixed to `tool.result` and reads `toolName`/`output`/`isError` from the real event shape.
- **S1:** Fact status in MemoryView was always "active" because the UI read `invalidatedAt` (absent); fixed to use `validUntil` (the real field). UI `Fact` type updated to match `@eidentic/types` (`validUntil`, `objectKind`, `confidence`).
- **S2:** Studio UI now sends an `Authorization: Bearer` header when a `?key=` token is present in the URL (persisted to `localStorage`). The CLI `studio` command warns when auth is configured so users know to append `?key=<token>`.
- **S3:** Aborting a streaming run no longer leaves a permanent blinking cursor — `streaming: false` is set on the in-flight entry in both `stop()` and the `finally` cleanup.
- **N2:** A `suspended` result is no longer shown in red as an error — it renders in a neutral info style with label "suspended (awaiting approval)".
- **N4:** Example config comment corrected: `new AIModel(anthropic(...))` (positional, not `{ model: ... }`).
- Backend shape-pinning tests added to `packages/studio/test/studio.test.ts` to catch future event-shape regressions server-side.
