---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/core": minor
"@eidentic/memory": minor
"@eidentic/lancedb": minor
"@eidentic/pgvector": minor
"@eidentic/qdrant": minor
"@eidentic/pinecone": minor
"@eidentic/skills": minor
---

Retrospective security/correctness/performance hardening across the stack:

- **Session safety:** `Session.open` now binds a session to its `agentId` (opening another agent's session throws), and turn-level event appends that conflict (e.g. a concurrent writer) yield a terminal `result{subtype:"error"}` instead of throwing out of the agent generator.
- **Prompt-context integrity:** untrusted text (memory block label/value, recall snippets, skill name/description) is escaped when assembled into the `<memory>`/`<recall>`/`<skills>` system-prompt regions, and memory block labels are charset-validated at the tool boundary — preventing delimiter/structure injection.
- **Scope isolation:** the `memories` re-index delete is now scope-filtered, and `VectorPort.delete` gained a required `scopeKey` argument (implemented across LanceDB/pgvector/Qdrant/Pinecone + fakes) so a duplicated id can't be deleted cross-tenant.
- **Vector scores unified:** all adapters now report cosine similarity (exact match ≈ 1.0); a conformance case pins this.
- **Consolidator:** model-supplied `confidence` is clamped to `[0,1]` (also in the `graph_assert` tool); facts rejected by the temporal-order guard are surfaced in a new `ConsolidationResult.rejected` bucket instead of being silently dropped.
- **Performance:** single store read in `getAlwaysInContext`, targeted `StorePort.getBlock(scope, label)` lookup for block edits, a new `idx_facts_scope_active` index for currently-valid-fact queries, cached session events (no double `readEvents` per turn), and precomputed skill search tokens.
