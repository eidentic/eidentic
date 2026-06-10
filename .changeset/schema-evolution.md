---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/memory": minor
---

§19 Schema/Prompt Evolution — three concrete, CI-testable pieces:

**§19.1 Event-schema upcasting** (`@eidentic/types`, `@eidentic/core`):
- New `upcastEvent` / `upcastEvents` / `Upcaster` / `EventUnupcastableError` / `DEFAULT_UPCASTERS` exported from `@eidentic/types`.
- `upcastEvents` is wired into `Session.open` (the read path): every replay / resume applies the upcaster chain before the loop sees any event. At v1 with an all-v1 log this is an identity pass (same array reference, zero allocation).
- `AgentConfig.upcasters?: Record<number, Upcaster>` — inject custom upcasters (merged on top of `DEFAULT_UPCASTERS`). Threaded to all three `Session.open` calls (query, resume, suspension-decision read).
- `DEFAULT_UPCASTERS` is empty at v1 (no prior version to migrate from). When the schema bumps to v2, add `DEFAULT_UPCASTERS[1] = ...`.

**§19.3 Embedding-model migration / re-index** (`@eidentic/memory`):
- New `Memory.reindexEmbeddings(scope, opts?)` — re-embeds every archived passage in `scope` with the CURRENT embedder. Call after swapping to a new model/dimension. Uses `vector.list` + `embedder.embedBatch` (falls back to per-item). Returns `{ reindexed: number }`. No-op when semantic is off or the adapter lacks `list`.

**§19.4 Instruction/prompt versioning** (`@eidentic/core`, `@eidentic/types`):
- `AgentConfig.instructionsVersion?: string` — opaque version tag for the agent's instructions.
- `RunTurnArgs.instructionsVersion?: string` — propagated through to `runTurn` / `resumeTurn`.
- `StreamEvent["session.init"]` gains an optional `instructionsVersion?: string` field. Present when configured; absent otherwise (byte-identical to previous behavior).

**Deferred** (noted for the record):
- §19.2 In-flight version-skew shim (request-level Accept-Version header negotiation for the HTTP server) — deferred; requires server-layer changes and is not testable without a live server.
- §19.5 / §19.6 Already covered by the existing SQLite migration system (schema-level DB migrations).
