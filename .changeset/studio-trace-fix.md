---
"@eidentic/studio": patch
"@eidentic/types": minor
"@eidentic/model": minor
"@eidentic/core": minor
---

Fix studio Sessions/Trace view always showing "unknown" for every event; surface real model id in session.init.

**Studio fix**: `SessionsView` was reading `event.type`/`event.content`/`event.output` — the stream-event shape — but the events endpoint returns `StoredEvent` objects (`{ id, sessionId, seq, kind, schemaVersion, payload, meta?, createdAt }`). Updated the component (and the local `StoredEvent` type in `api.ts`) to read `event.kind` for the label and `event.payload`/`event.meta` for per-kind summaries (user string, assistant text/tool_use blocks, tool_result toolName+output, other kinds as JSON snippet). `seq` is now shown in the row header.

**ModelId flow**: `ModelPort` gains an optional `modelId?: string` field. `AIModel` sets `this.modelId` from the wrapped AI SDK `LanguageModel.modelId` (available when a static model is passed; undefined for resolver-based construction). `Agent` now resolves `config.modelId ?? config.model.modelId` for the `modelId` arg passed to `runTurn`/`resumeTurn`, so `session.init.model` carries the real provider model id (e.g. `"claude-sonnet-4-5"`) with zero config. When neither is set, behavior is byte-identical to before (`""`).
