---
"@eidentic/pgvector": minor
---

New `@eidentic/pgvector` adapter: a drop-in `VectorPort` for Postgres + pgvector. Accepts any injected `{ query(text, params) }` client (`pg.Pool` or `@electric-sql/pglite`), so it opens no socket itself. Cosine recall via the `<=>` operator (`score = 1 - distance`), scope-isolated by `scope_key`, idempotent upsert via `ON CONFLICT`. Conformance is verified for real in CI against embedded Postgres (pglite); a gated live test (`EIDENTIC_TEST_PG_URL`) covers a real server. Depends only on `@eidentic/types` at runtime; `pg` is an optional peer dependency.
