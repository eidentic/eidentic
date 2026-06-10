# @eidentic/pgvector

pgvector adapter for Eidentic — vector search over PostgreSQL (or PGlite) using the
pgvector extension. Implements `VectorPort` from `@eidentic/types`. Requires the
`pgvector` extension enabled in your database; the adapter creates it and the table
automatically on first use.

## Install

```bash
pnpm add @eidentic/pgvector pg
# or with pglite (in-process, no server needed):
pnpm add @eidentic/pgvector @electric-sql/pglite
```

## Usage

```ts
import { PgVectorStore } from "@eidentic/pgvector";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const vector = await PgVectorStore.create({
  client: pool,
  table: "memory_vectors", // optional, defaults to "memories"
  dim: 1536,
});

// Use with Memory
import { Memory } from "@eidentic/memory";
const memory = new Memory({ store, vector, embedder });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
