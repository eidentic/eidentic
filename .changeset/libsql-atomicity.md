---
"@eidentic/libsql": patch
---

Fix `@eidentic/libsql` read-modify-write races (B1): `appendBlock`, `upsertBlock` (CAS), and `assertFact` were non-atomic — a SELECT followed by a separate write with no transaction, so concurrent writers could lose data or leave duplicate valid facts. Fixed: `appendBlock` uses a single `ON CONFLICT DO UPDATE SET value = value || ?` statement (no separate read needed); `upsertBlock` CAS pushes the version predicate into the `UPDATE … WHERE version = ?` and checks `rowsAffected`; `assertFact` serializes concurrent callers via a JS-level mutex and uses `client.batch("write")` for the atomic invalidate-old + insert-new write.
