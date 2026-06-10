/** Minimal client surface — must match the PgClient interface in index.ts. */
interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        meta TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS blocks (
        scope_key TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, label)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        scope_key TEXT NOT NULL,
        ext_id TEXT NOT NULL,
        text TEXT NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
        PRIMARY KEY (scope_key, ext_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_gin ON memories USING GIN (tsv);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope_key);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS block_history (
        scope_key TEXT NOT NULL,
        label TEXT NOT NULL,
        version INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, label, version)
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        confidence REAL NOT NULL,
        source TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_spo ON facts (scope_key, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_facts_scope_active ON facts (scope_key, valid_until);
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts (scope_key, expires_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS suspension_decisions (
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      );
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS org_id TEXT;
    `,
  },
  {
    version: 8,
    // Unlike SQLite FTS5 virtual tables, Postgres memories is a plain table.
    // We can add columns directly. ingested_at stores epoch-ms; metadata is JSONB.
    // Old rows get NULL for both columns — the memory layer falls back gracefully
    // (similarity-only ranking, no metadata) for entries ingested before this migration.
    sql: `
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS ingested_at BIGINT;
      ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB;
    `,
  },
  {
    version: 9,
    // State-transition + corroboration tiers. `supersedes` links a fact to the prior fact it
    // replaced on contradiction-invalidation (NULL for the first version in a chain).
    // `last_corroborated_at` (epoch-ms) records the last re-confirmation; defaults to validFrom.
    sql: `
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS supersedes TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_corroborated_at BIGINT;
    `,
  },
];

export async function runMigrations(client: PgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _eidentic_migrations (
      version INTEGER PRIMARY KEY
    )
  `);
  const { rows } = await client.query(`SELECT version FROM _eidentic_migrations`);
  const applied = new Set(rows.map((r: { version: number }) => r.version));

  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      await client.query("BEGIN");
      try {
        // Split on statement boundaries and run each — pglite handles batches better one-by-one
        const stmts = m.sql
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of stmts) {
          await client.query(stmt);
        }
        await client.query(`INSERT INTO _eidentic_migrations (version) VALUES ($1)`, [m.version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  }
}
