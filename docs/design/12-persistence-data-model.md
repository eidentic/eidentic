# 12. Persistence & Data Model

[← 11. Observability + Cost + Eval](11-observability-cost-eval.md) · [Index](master-design.md) · Next: [13. Packaging & DX →](13-packaging-dx.md)

One data model, two backends, behind `StorePort`/`VectorPort`. Embedded default is
libSQL/SQLite (zero infra); production scales to Postgres + pgvector — same schema,
clean migration path. Every table is scope-keyed for multi-tenant isolation.

## 12.1 Ports

```ts
interface StorePort {
  // event-sourced sessions (§9)
  appendEvents(sessionId: string, events: Event[]): Promise<void>
  readEvents(sessionId: string, fromCheckpoint?: string): Promise<Event[]>
  // memory (§6)
  getBlocks(scope: MemoryScope): Promise<MemoryBlock[]>
  upsertBlock(b: MemoryBlock, expectVersion?: number): Promise<MemoryBlock>  // CAS (replace/rewrite)
  appendBlock(scope: MemoryScope, label: string, text: string): Promise<void> // ATOMIC, contention-free (§0-C10)
  appendBlockHistory(h: BlockHistory): Promise<void>
  putFact(f: Fact): Promise<void>; queryFacts(q: FactQuery): Promise<Fact[]>
  // idempotency (§9.3), concurrency (§16), governance (§15)
  recordIntent(k: IdempotencyKey): Promise<'new' | 'duplicate'>
  markApplied(k: IdempotencyKey, resultHandle: string): Promise<void>
  withLock(scope: MemoryScope, fn: () => Promise<T>): Promise<T>     // advisory lock for hot scopes
  eraseByScope(scope: MemoryScope | { subjectId: string }): Promise<void>  // §15.3, conformance-required
  // skills (§7), checkpoints (§9), cost (§11) …
  migrate(): Promise<void>     // run-on-startup, versioned, forward-only (§19.6)
}
interface VectorPort {
  upsert(scope: MemoryScope, items: VectorItem[]): Promise<void>
  search(scope: MemoryScope, query: number[]|string, k: number, filter?: Filter): Promise<Hit[]>
}
```

## 12.2 Schema (canonical)

```sql
-- Sessions & event sourcing (durability + tracing + audit, all one log)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope JSON NOT NULL,
  status TEXT, metadata JSON, created_at, updated_at );

CREATE TABLE events (                       -- append-only
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id),
  seq INTEGER NOT NULL, kind TEXT NOT NULL, -- user|assistant|tool_call|tool_result|checkpoint|compaction|erasure
  schema_version INTEGER NOT NULL,          -- §19.1 upcasting; readers tolerate older versions
  payload JSON NOT NULL,                    -- DETERMINISTIC replay subset (hashed)
  meta JSON,                                -- cost/timing/trace — NON-hashed observational metadata (§0-C5)
  data_class TEXT,                          -- public|internal|pii|secret|untrusted (§15.2)
  created_at );
CREATE INDEX idx_events_session ON events(session_id, seq);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, code_version TEXT,  -- §19.2 skew detection
  state JSON NOT NULL, content_hash TEXT, created_at );  -- hash excludes cost/timestamps

-- Exactly-once ledger (§9.3, §0-C2) — the durability mechanism's missing schema
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,                 -- caller-supplied or derived (MUST include args, e.g. orderId:amount)
  args_hash TEXT NOT NULL,
  session_id TEXT, tool_name TEXT,
  status TEXT NOT NULL,              -- intent | applied
  result_handle TEXT,               -- where the applied result is stored
  created_at, applied_at,
  PRIMARY KEY (key, args_hash) );

-- Memory tier 1: blocks + audit
CREATE TABLE blocks (
  id TEXT PRIMARY KEY, scope JSON NOT NULL, label TEXT NOT NULL,
  description TEXT, value TEXT, char_limit INTEGER, read_only BOOLEAN,
  version INTEGER NOT NULL DEFAULT 0, updated_at,
  UNIQUE(scope, label) );
CREATE TABLE block_history (
  id INTEGER PRIMARY KEY, block_id TEXT, prev_value TEXT, version INTEGER,
  actor TEXT, created_at );

-- Memory tier 3: archival (vector lives in VectorPort; metadata here)
CREATE TABLE archival_passages (
  id TEXT PRIMARY KEY, scope JSON NOT NULL, content TEXT, metadata JSON,
  source_event TEXT, dedup_hash TEXT, created_at, expires_at );   -- TTL/staleness

-- Memory tier 4: temporal knowledge graph
CREATE TABLE entities (
  id TEXT PRIMARY KEY, scope JSON, name TEXT, type TEXT, properties JSON,
  UNIQUE(scope, name, type) );
CREATE TABLE facts (                         -- temporal validity
  id TEXT PRIMARY KEY, scope JSON, subject TEXT, predicate TEXT, object JSON,
  valid_from TEXT, valid_until TEXT, confidence REAL, source_event TEXT );
CREATE INDEX idx_facts_temporal ON facts(scope, subject, valid_from, valid_until);

-- Skills (§7)
CREATE TABLE skills (
  id TEXT PRIMARY KEY, scope JSON, name TEXT, description TEXT,
  kind TEXT, body TEXT, code TEXT, version INTEGER, provenance JSON,
  signature TEXT, tests JSON, UNIQUE(scope, name, version) );
CREATE TABLE skill_memory (                  -- per-skill .memory.md (§7.5)
  id INTEGER PRIMARY KEY, skill_id TEXT, note TEXT, outcome TEXT, created_at );

-- Tool registry (DB-stored tools, optional), cost rollups, etc.
CREATE TABLE tools ( id TEXT PRIMARY KEY, scope JSON, name TEXT, input_schema JSON,
  output_schema JSON, annotations JSON, version INTEGER );
```

Recall tier 2 search uses SQLite **FTS5** / Postgres full-text over `events`; the lexical
signal (§6.4) reads the same. The vector signal reads `VectorPort` (LanceDB embedded /
pgvector / Qdrant). One Postgres can hold relational + vector (pgvector cohabitation,
simplifying ops — a well-validated choice).

## 12.3 Scope-keyed isolation

Every domain table carries `scope JSON` (§6.7). The store **always** injects a scope
predicate into queries — row-level tenant isolation enforced at the data layer, not the app
layer. Server mode adds `org_id`/`user_id` indexing for multi-tenant scale.

## 12.4 Database-per-agent vs shared

- **Embedded default:** one libSQL file per app (or per agent for strong isolation — the
  Turso "database-per-agent" pattern, sub-ms local reads).
- **Server:** shared Postgres with scope/org partitioning; optional schema-per-tenant for
  hard isolation.

## 12.5 Migration discipline (no SQLite trap)

Self-hosters who can't migrate SQLite between versions are forced onto Postgres — a
documented pain point. Eidentic requires **both** backends to support versioned migrations from day
one: a `migrations/` folder, `store.migrate()` run-on-startup, forward-only with explicit
data transforms. SQLite is a first-class, upgradable backend, not a demo-only escape hatch.

## 12.6 Serialization & stability

Events use deterministic JSON (stable key order) — required for KV-cache friendliness (§4.3)
and content-addressed checkpoints (§9.2). State must be serializable (no live handles, §9.1).
The event schema is versioned; readers tolerate older event versions (forward-compatible),
upholding the no-breaking-changes promise at the data layer.

## 12.7 Traceability

- SQLite-can't-migrate pain → §12.5 versioned migrations both backends.
- Cross-user pollution → §12.3 store-enforced scope predicates.
- 90 MB bundle → §12.1 ports; storage adapters are separate packages (§2.2).
- Temporal-memory gap → §12.2 `facts` with validity intervals.
