import type { VectorPort, VectorEntry, VectorSearchResult } from "@eidentic/types";

/** Minimal client surface satisfied by both `pg.Pool` and `@electric-sql/pglite`. */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Render a numeric vector as a pgvector literal, e.g. [1,2,3] -> "[1,2,3]". Bound as a parameter (never interpolated). */
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Parse a stored `embedding` column back into a `number[]`. pgvector returns the value as a
 * `"[1,2,3]"` string under most drivers (node-postgres, pglite); some return a real array. Handle both.
 */
function parseVectorLiteral(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string") {
    const inner = v.replace(/^\[|\]$/g, "").trim();
    return inner.length === 0 ? [] : inner.split(",").map((s) => Number(s));
  }
  return [];
}

/** Validate a table identifier (we interpolate it into DDL/DML; pgvector has no bind for identifiers). */
function safeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid table name '${name}': must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PgVectorStore implements VectorPort {
  private constructor(
    private readonly client: PgClient,
    private readonly table: string,
    readonly dim: number,
  ) {}

  static async create(opts: { client: PgClient; table?: string; dim: number }): Promise<PgVectorStore> {
    const { client, dim } = opts;
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`dim must be a positive integer, got ${dim}`);
    const table = safeIdent(opts.table ?? "memories");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    // Create table with composite primary key (id, scope_key).  This guarantees tenant isolation:
    // two tenants may hold the same logical id without overwriting each other's rows, and the ON
    // CONFLICT target below is scoped so Tenant B's upsert can never replace Tenant A's row.
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (` +
        `id text NOT NULL, ` +
        `scope_key text NOT NULL, ` +
        `text text NOT NULL, ` +
        `embedding vector(${dim}), ` +
        `PRIMARY KEY (id, scope_key)` +
        `)`,
    );
    // Migrate legacy tables that were created with a single-column `id` primary key.
    // Detection: pg_constraint shows a PRIMARY KEY constraint whose conkey covers exactly one column
    // and that column is `id`.  We drop the old constraint, add the composite one, and leave all
    // existing data intact.  The migration is idempotent: if the composite PK already exists the
    // ALTER TABLE statements below are skipped entirely.
    const migResult = await client.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = $1
          AND c.contype = 'p'
          AND array_length(c.conkey, 1) = 1`,
      [table],
    );
    if (migResult.rows.length > 0) {
      const constraintName = String((migResult.rows[0] as Record<string, unknown>)["conname"]);
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(constraintName)}`);
      await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (id, scope_key)`);
    }
    // Plain btree index on scope_key accelerates the scoped filter; the ORDER BY uses a sequential cosine scan,
    // which is exact and correct for the conformance suite. (An ivfflat/hnsw ANN index is an optional production
    // tuning the user can add on their own table; we keep correctness-first here.)
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_scope_idx ON ${table} (scope_key)`);
    return new PgVectorStore(client, table, dim);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    if (entry.vector.length !== this.dim) {
      throw new Error(`vector dim ${entry.vector.length} != table dim ${this.dim}`);
    }
    // Conflict target is the composite key (id, scope_key) — a row in a different scope is never
    // matched, so cross-tenant overwrites are structurally impossible.
    await this.client.query(
      `INSERT INTO ${this.table} (id, scope_key, text, embedding) VALUES ($1, $2, $3, $4) ` +
        `ON CONFLICT (id, scope_key) DO UPDATE SET text = EXCLUDED.text, embedding = EXCLUDED.embedding`,
      [entry.id, entry.scopeKey, entry.text, vectorLiteral(entry.vector)],
    );
  }

  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    const { rows } = await this.client.query(
      `SELECT id, text, 1 - (embedding <=> $1) AS score FROM ${this.table} ` +
        `WHERE scope_key = $2 ORDER BY embedding <=> $1 LIMIT $3`,
      [vectorLiteral(queryVector), scopeKey, topK],
    );
    // pgvector `<=>` is cosine distance ∈ [0,2]; score = 1 - distance ∈ [-1,1], monotonically increasing in
    // similarity → identical ranking to LanceDB and the in-memory fake. score is returned as a string by some
    // drivers, so coerce to number.
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return { id: String(row["id"]), text: String(row["text"]), score: Number(row["score"]) };
    });
  }

  async delete(id: string, scopeKey: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1 AND scope_key = $2`, [id, scopeKey]);
  }

  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    const { rows } = await this.client.query(
      `DELETE FROM ${this.table} WHERE scope_key = $1 RETURNING id`,
      [scopeKey],
    );
    return { deleted: rows.length };
  }

  /**
   * Enumerate every entry in `scopeKey` (used by `Memory.deduplicateArchival` / `reindexEmbeddings`).
   * A scoped sequential scan — exact and correct; the `scope_key` btree index keeps it efficient.
   */
  async list(scopeKey: string): Promise<VectorEntry[]> {
    const { rows } = await this.client.query(
      `SELECT id, scope_key, text, embedding FROM ${this.table} WHERE scope_key = $1`,
      [scopeKey],
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row["id"]),
        scopeKey: String(row["scope_key"]),
        text: String(row["text"]),
        vector: parseVectorLiteral(row["embedding"]),
      };
    });
  }
}
