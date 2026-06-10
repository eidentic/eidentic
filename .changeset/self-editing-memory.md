---
"@eidentic/types": minor
"@eidentic/sqlite": minor
"@eidentic/memory": minor
"@eidentic/core": minor
---

Self-editing memory blocks (Tier-1): the agent edits its own always-in-context blocks during reasoning via `memory_append` / `memory_replace` / `memory_rewrite` / `memory_archive` tools. Every mutation is recorded in a `block_history` audit trail (new SQLite migration v3 + `StorePort.getBlockHistory`). Guardrails: per-block `limit` and `readOnly` enforcement and compare-and-swap (CAS) on `version` for `replace`/`rewrite`; `append` stays conflict-free. Block metadata lives in the memory-layer config (`blocks: { label: { description, limit, readOnly } }`); `LiteMemory`/`FullMemory` now implement `EditableMemoryPort` via a shared `BlockEditor`. Drop-in unchanged: the editable methods are additive and the no-memory loop path is byte-for-byte identical.
