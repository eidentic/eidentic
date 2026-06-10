---
"@eidentic/sqlite": minor
---

Lazy-load `better-sqlite3` so importing `@eidentic/sqlite` (and the `eidentic` umbrella) is safe on any runtime — only `new SqliteStore()` needs the native addon. Moves `better-sqlite3` to `optionalDependencies`; on Deno/edge/Workers use `@eidentic/libsql` (Turso) or `@eidentic/postgres` instead.
