---
"@eidentic/types": major
"@eidentic/core": major
"@eidentic/model": minor
"@eidentic/memory": major
"@eidentic/sqlite": minor
"@eidentic/libsql": minor
"@eidentic/postgres": minor
"@eidentic/convex": minor
"@eidentic/tools": minor
"@eidentic/rag": minor
"@eidentic/e2b": minor
"@eidentic/prompts": minor
"@eidentic/cli": minor
"@eidentic/pgvector": patch
"@eidentic/server": major
"eidentic": major
---

Harden identity, tenant ownership, erasure, durable idempotency, event replay, multimodal input,
credential storage, filesystem writes, outbound requests, runtime limits, graph concurrency, and
error/output boundaries. Scope and idempotency keys now use versioned injective tuple formats when
legacy delimiters are ambiguous. Store and durable adapters gain governance, credential-CAS, and
atomic intent-claim operations; custom adapters must implement the expanded port contracts.

Convex public handlers now deny when no authorization hook is configured. Explicitly named unsafe
compatibility options remain for controlled migration only. See
`docs/design/21-security-boundary-migrations.md` for migration rules and infrastructure limits.
