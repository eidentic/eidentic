---
"@eidentic/core": minor
"@eidentic/memory": minor
---

Add `Agent.eraseScope(scope)` — GDPR right-to-erasure fan-out coordinator (§15): one call hard-deletes all of a subject's data across sessions, memory (store + FTS + in-memory metadata/ingestedAt maps), vector store, and graph. `Memory.eraseScope` now also purges in-memory `metadataStore` and `ingestedAtStore` entries via a new scope-to-ids index populated during ingest. Cross-scope isolation guaranteed (erasing user A leaves user B intact); idempotent; adapters without `eraseScope` degrade gracefully (`memorySkipped: true`).
