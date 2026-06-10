import type { Client } from "@libsql/client";

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string[] }> = [
  {
    version: 1,
    sql: [
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        meta TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, seq)
      )`,
      `CREATE INDEX idx_events_session ON events(session_id, seq)`,
      `CREATE TABLE blocks (
        scope_key TEXT NOT NULL,
        label TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, label)
      )`,
    ],
  },
  {
    version: 2,
    sql: [
      `CREATE VIRTUAL TABLE memories USING fts5(
        scope_key UNINDEXED,
        ext_id UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
    ],
  },
  {
    version: 3,
    sql: [
      `CREATE TABLE block_history (
        scope_key TEXT NOT NULL,
        label TEXT NOT NULL,
        version INTEGER NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, label, version)
      )`,
    ],
  },
  {
    version: 4,
    sql: [
      `CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        confidence REAL NOT NULL,
        source TEXT
      )`,
      `CREATE INDEX idx_facts_spo ON facts (scope_key, subject, predicate)`,
    ],
  },
  {
    version: 5,
    sql: [
      `CREATE INDEX idx_facts_scope_active ON facts (scope_key, valid_until)`,
    ],
  },
  {
    version: 6,
    sql: [
      `CREATE TABLE checkpoints (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      )`,
      `CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 7,
    sql: [
      `CREATE TABLE suspension_decisions (
        session_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, call_id)
      )`,
    ],
  },
  {
    version: 8,
    sql: [
      `ALTER TABLE facts ADD COLUMN expires_at TEXT`,
      `CREATE INDEX idx_facts_expires ON facts (scope_key, expires_at)`,
    ],
  },
  {
    version: 9,
    sql: [
      `ALTER TABLE sessions ADD COLUMN user_id TEXT`,
      `ALTER TABLE sessions ADD COLUMN org_id TEXT`,
    ],
  },
  {
    version: 10,
    // FTS5 virtual tables do not support ALTER TABLE ADD COLUMN.
    // We use a sidecar table (memory_meta) keyed by (scope_key, ext_id) to persist
    // ingested_at timestamps and metadata alongside the FTS index.
    sql: [
      `CREATE TABLE memory_meta (
        scope_key TEXT NOT NULL,
        ext_id TEXT NOT NULL,
        ingested_at INTEGER NOT NULL,
        metadata TEXT,
        PRIMARY KEY (scope_key, ext_id)
      )`,
    ],
  },
  {
    version: 11,
    // State-transition + corroboration tiers. `supersedes` links a fact to the prior fact it
    // replaced on contradiction-invalidation (NULL for the first version in a chain).
    // `last_corroborated_at` (epoch-ms) records the last re-confirmation; defaults to validFrom.
    sql: [
      `ALTER TABLE facts ADD COLUMN supersedes TEXT`,
      `ALTER TABLE facts ADD COLUMN last_corroborated_at INTEGER`,
    ],
  },
];

export async function runMigrations(client: Client): Promise<void> {
  // Ensure the migrations tracking table exists (non-transactional DDL via executeMultiple is fine here).
  await client.executeMultiple(
    `CREATE TABLE IF NOT EXISTS _eidentic_migrations (version INTEGER PRIMARY KEY)`,
  );

  const appliedRows = await client.execute(`SELECT version FROM _eidentic_migrations`);
  const applied = new Set(appliedRows.rows.map((r) => r["version"] as number));

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Execute each DDL statement plus the version insert as a batch (atomic).
    await client.batch(
      [
        ...m.sql.map((sql) => ({ sql })),
        { sql: `INSERT INTO _eidentic_migrations (version) VALUES (?)`, args: [m.version] },
      ],
      "write",
    );
  }
}
