import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import {
  StoreConflictError,
  scopeKey,
  tokenize,
  type StorePort,
  type Scope,
  type MemoryBlock,
  type BlockHistoryEntry,
  type MemorySnippet,
  type SessionRecord,
  type StoredEvent,
  type GraphPort,
  type Fact,
  type AssertFactInput,
  type FactQuery,
  type DurablePort,
  type Checkpoint,
  type IdempotencyRecord,
  type IdempotencyMetadata,
  type IdempotencyStatus,
  type SuspendDecision,
} from "@eidentic/types";
import { runMigrations } from "./migrations.js";

export interface LibsqlStoreOptions {
  url?: string;
  authToken?: string;
  /** Override for fact ID generation (useful in tests for determinism). */
  newId?: () => string;
  /** Override for "now" timestamp (useful in tests). */
  now?: () => string;
}

/** Turn arbitrary user text into a safe FTS5 MATCH expression (OR of quoted tokens), or null if no tokens. */
function ftsMatch(text: string): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  // Escape embedded double-quotes by doubling them (FTS5 quoted-token syntax).
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

type RowValue = import("@libsql/client").Value | undefined;

/** Coerce a libSQL Value to string safely. */
function str(v: RowValue): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

function strOrNull(v: RowValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function num(v: RowValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseFloat(v);
  return 0;
}

function numOrNull(v: RowValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") { const n = parseFloat(v); return Number.isNaN(n) ? null : n; }
  return null;
}

type Stmt = { sql: string; args?: import("@libsql/client").InArgs };

function sessionSelection(scope: Scope): { where: string; args: string[] } | null {
  if (scope.kind === "agent") return { where: "agent_id = ?", args: [scope.agentId] };
  if (scope.kind === "user") return { where: "agent_id = ? AND user_id = ?", args: [scope.agentId, scope.userId] };
  if (scope.kind === "org") return { where: "agent_id = ? AND org_id = ?", args: [scope.agentId, scope.orgId] };
  if (scope.kind === "thread") return { where: "agent_id = ? AND id = ?", args: [scope.agentId, scope.sessionId] };
  return null;
}

export class LibsqlStore implements StorePort, GraphPort, DurablePort {
  private readonly client: Client;
  private factIdCounter = 0;
  private readonly newFactId: () => string;
  private readonly graphNow: () => string;
  /**
   * Serializes concurrent assertFact calls on the same store instance.
   *
   * assertFact must read the current state, check invariants, then atomically write
   * (invalidate old + insert new). Within a single Node.js process those three steps
   * interleave at every `await`, so two concurrent callers can both observe "no
   * current fact" and both insert — producing two valid rows.
   *
   * This mutex reduces avoidable local lock contention. Correctness across store instances and
   * processes comes from executing the read, conditional insert, invalidation and activation in
   * one `client.batch("write")` transaction (BEGIN IMMEDIATE).
   */
  private assertFactMutex: Promise<void> = Promise.resolve();

  constructor(optsOrUrl: LibsqlStoreOptions | string = ":memory:") {
    const opts: LibsqlStoreOptions =
      typeof optsOrUrl === "string" ? { url: optsOrUrl } : optsOrUrl;
    const url = opts.url ?? ":memory:";
    this.client = createClient({ url, authToken: opts.authToken });
    this.newFactId =
      opts.newId ??
      (() => `fact_${Date.now().toString(36)}_${(this.factIdCounter++).toString(36)}`);
    this.graphNow = opts.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<void> {
    await runMigrations(this.client);
  }

  async close(): Promise<void> {
    this.client.close();
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async createSession(s: SessionRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO sessions (id, agent_id, created_at, user_id, org_id, api_key) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [s.id, s.agentId, s.createdAt, s.userId ?? null, s.orgId ?? null, s.apiKey ?? null],
    });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const rs = await this.client.execute({
      sql: `SELECT id, agent_id, created_at, user_id, org_id, api_key FROM sessions WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    const userId = strOrNull(row["user_id"]);
    const orgId = strOrNull(row["org_id"]);
    const apiKey = strOrNull(row["api_key"]);
    return {
      id: str(row["id"]),
      agentId: str(row["agent_id"]),
      createdAt: str(row["created_at"]),
      ...(userId !== null ? { userId } : {}),
      ...(orgId !== null ? { orgId } : {}),
      ...(apiKey !== null ? { apiKey } : {}),
    };
  }

  async replaceSessionApiKey(sessionId: string, expected: string, replacement: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE sessions SET api_key = ? WHERE id = ? AND api_key = ?`,
      args: [replacement, sessionId, expected],
    });
    return result.rowsAffected === 1;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  async appendEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.client.batch(
        events.map((e): Stmt => ({
          sql: `INSERT INTO events (id, session_id, seq, kind, schema_version, payload, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            e.id,
            e.sessionId,
            e.seq,
            e.kind,
            e.schemaVersion,
            JSON.stringify(e.payload),
            e.meta !== undefined ? JSON.stringify(e.meta) : null,
            e.createdAt,
          ],
        })),
        "write",
      );
    } catch (err) {
      if (
        err instanceof Error &&
        /SQLITE_CONSTRAINT|UNIQUE constraint|conflict/i.test(err.message)
      ) {
        throw new StoreConflictError(`conflict: ${err.message}`);
      }
      throw err;
    }
  }

  async readEvents(sessionId: string): Promise<StoredEvent[]> {
    const rs = await this.client.execute({
      sql: `SELECT id, session_id, seq, kind, schema_version, payload, meta, created_at FROM events WHERE session_id = ? ORDER BY seq ASC`,
      args: [sessionId],
    });
    return rs.rows.map((r) => ({
      id: str(r["id"]),
      sessionId: str(r["session_id"]),
      seq: num(r["seq"]),
      kind: str(r["kind"]) as StoredEvent["kind"],
      schemaVersion: num(r["schema_version"]),
      payload: JSON.parse(str(r["payload"])),
      meta: r["meta"] !== null && r["meta"] !== undefined ? JSON.parse(str(r["meta"])) : undefined,
      createdAt: str(r["created_at"]),
    }));
  }

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  async getBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const rs = await this.client.execute({
      sql: `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ?`,
      args: [scopeKey(scope)],
    });
    return rs.rows.map((r) => ({
      label: str(r["label"]),
      value: str(r["value"]),
      version: num(r["version"]),
      updatedAt: str(r["updated_at"]),
    }));
  }

  async getBlock(scope: Scope, label: string): Promise<MemoryBlock | null> {
    const rs = await this.client.execute({
      sql: `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ? AND label = ?`,
      args: [scopeKey(scope), label],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      label: str(row["label"]),
      value: str(row["value"]),
      version: num(row["version"]),
      updatedAt: str(row["updated_at"]),
    };
  }

  async upsertBlock(
    scope: Scope,
    block: { label: string; value: string },
    expectVersion?: number,
  ): Promise<MemoryBlock> {
    const key = scopeKey(scope);
    const now = new Date().toISOString();

    if (expectVersion === undefined) {
      // No CAS: use an atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING to compute
      // the new version server-side, eliminating the read-modify-write race.
      const results = await this.client.batch(
        [
          {
            sql: `INSERT INTO blocks (scope_key, label, value, version, updated_at)
                  VALUES (?, ?, ?, 0, ?)
                  ON CONFLICT(scope_key, label) DO UPDATE SET
                    value = excluded.value,
                    version = blocks.version + 1,
                    updated_at = excluded.updated_at
                  RETURNING version`,
            args: [key, block.label, block.value, now],
          },
          {
            // Mirror the updated row into block_history within the same batch transaction.
            sql: `INSERT OR REPLACE INTO block_history (scope_key, label, version, value, updated_at)
                  SELECT scope_key, label, version, value, updated_at FROM blocks
                  WHERE scope_key = ? AND label = ?`,
            args: [key, block.label],
          },
        ],
        "write",
      );
      const version = num(results[0]?.rows[0]?.["version"]);
      return { label: block.label, value: block.value, version, updatedAt: now };
    }

    // CAS path: push the version predicate into the UPDATE itself so the check and
    // write are a single atomic SQL operation — no separate SELECT is needed, and no
    // interleaving between read and write is possible even under concurrent callers.
    //
    // The history INSERT uses a sub-SELECT that only matches if the UPDATE succeeded
    // (the row now has version = expectVersion + 1), so history is written iff the
    // CAS wins.
    const newVersion = expectVersion + 1;
    const results = await this.client.batch(
      [
        {
          sql: `UPDATE blocks SET value = ?, version = ?, updated_at = ?
                WHERE scope_key = ? AND label = ? AND version = ?`,
          args: [block.value, newVersion, now, key, block.label, expectVersion],
        },
        {
          sql: `INSERT OR REPLACE INTO block_history (scope_key, label, version, value, updated_at)
                SELECT scope_key, label, version, value, updated_at FROM blocks
                WHERE scope_key = ? AND label = ? AND version = ?`,
          args: [key, block.label, newVersion],
        },
      ],
      "write",
    );

    const rowsAffected = results[0]?.rowsAffected ?? 0;
    if (rowsAffected === 0) {
      // CAS failed — read the current state to build a meaningful error message.
      const currentRs = await this.client.execute({
        sql: `SELECT version FROM blocks WHERE scope_key = ? AND label = ?`,
        args: [key, block.label],
      });
      const currentRow = currentRs.rows[0];
      if (!currentRow) {
        throw new StoreConflictError(
          `conflict: block ${block.label} expected version ${expectVersion} but it does not exist`,
        );
      }
      throw new StoreConflictError(
        `conflict: block ${block.label} version ${num(currentRow["version"])} != expected ${expectVersion}`,
      );
    }

    return { label: block.label, value: block.value, version: newVersion, updatedAt: now };
  }

  async appendBlock(scope: Scope, label: string, text: string): Promise<MemoryBlock> {
    const key = scopeKey(scope);
    const now = new Date().toISOString();

    // The ON CONFLICT DO UPDATE clause performs the concatenation server-side so no
    // separate SELECT is needed — eliminating the read-modify-write race.  Both the
    // blocks upsert and the block_history insert run inside the same implicit write
    // transaction (client.batch "write" mode), so they commit or rollback together.
    //
    // The second statement reads the already-updated row from blocks to produce the
    // history record: within a batch transaction, the SELECT sees the row written by
    // the first statement.
    const results = await this.client.batch(
      [
        {
          sql: `INSERT INTO blocks (scope_key, label, value, version, updated_at)
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(scope_key, label) DO UPDATE SET
                  value = blocks.value || excluded.value,
                  version = blocks.version + 1,
                  updated_at = excluded.updated_at
                RETURNING value, version`,
          args: [key, label, text, now],
        },
        {
          // Insert history by reading the just-written row — within the same batch
          // transaction, this SELECT sees the updated blocks row.
          sql: `INSERT OR REPLACE INTO block_history (scope_key, label, version, value, updated_at)
                SELECT scope_key, label, version, value, updated_at FROM blocks
                WHERE scope_key = ? AND label = ?`,
          args: [key, label],
        },
      ],
      "write",
    );
    const row = results[0]?.rows[0];
    const value = str(row?.["value"]);
    const version = num(row?.["version"]);
    return { label, value, version, updatedAt: now };
  }

  async getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]> {
    const rs = await this.client.execute({
      sql: `SELECT label, value, version, updated_at FROM block_history WHERE scope_key = ? AND label = ? ORDER BY version ASC`,
      args: [scopeKey(scope), label],
    });
    return rs.rows.map((r) => ({
      label: str(r["label"]),
      value: str(r["value"]),
      version: num(r["version"]),
      updatedAt: str(r["updated_at"]),
    }));
  }

  /** Atomically write blocks + block_history via a single batch (write transaction). */
  private async writeBothBlockTables(
    scopeKeyStr: string,
    label: string,
    value: string,
    version: number,
    now: string,
  ): Promise<void> {
    await this.client.batch(
      [
        {
          sql: `INSERT INTO blocks (scope_key, label, value, version, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scope_key, label) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
          args: [scopeKeyStr, label, value, version, now],
        },
        {
          sql: `INSERT OR REPLACE INTO block_history (scope_key, label, version, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
          args: [scopeKeyStr, label, version, value, now],
        },
      ],
      "write",
    );
  }

  // ---------------------------------------------------------------------------
  // Memory / FTS5
  // ---------------------------------------------------------------------------

  async indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>): Promise<void> {
    if (entries.length === 0) return;
    // Delete then insert atomically via batch.
    const stmts: Stmt[] = [];
    for (const e of entries) {
      stmts.push({
        sql: `DELETE FROM memories WHERE scope_key = ? AND ext_id = ?`,
        args: [scopeKey(e.scope), e.id],
      });
    }
    for (const e of entries) {
      stmts.push({
        sql: `INSERT INTO memories (scope_key, ext_id, text) VALUES (?, ?, ?)`,
        args: [scopeKey(e.scope), e.id, e.text],
      });
    }
    // Persist ingested_at + metadata when provided.
    for (const e of entries) {
      if (e.ingestedAt !== undefined) {
        stmts.push({
          sql: `INSERT INTO memory_meta (scope_key, ext_id, ingested_at, metadata) VALUES (?, ?, ?, ?)
                ON CONFLICT(scope_key, ext_id) DO UPDATE SET ingested_at = excluded.ingested_at, metadata = excluded.metadata`,
          args: [scopeKey(e.scope), e.id, e.ingestedAt, e.metadata !== undefined ? JSON.stringify(e.metadata) : null],
        });
      }
    }
    await this.client.batch(stmts, "write");
  }

  async searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]> {
    const match = ftsMatch(query);
    if (!match) return [];
    // FTS5 bm25() requires the virtual table's own name (not an alias).
    const rs = await this.client.execute({
      sql: `SELECT memories.ext_id AS id, memories.text AS text, -bm25(memories) AS score,
                   mm.ingested_at, mm.metadata
            FROM memories
            LEFT JOIN memory_meta mm ON mm.scope_key = memories.scope_key AND mm.ext_id = memories.ext_id
            WHERE memories.scope_key = ? AND memories.text MATCH ?
            ORDER BY bm25(memories)
            LIMIT ?`,
      args: [scopeKey(scope), match, topK],
    });
    return rs.rows.map((r) => {
      const ingestedAt = r["ingested_at"];
      const metaStr = strOrNull(r["metadata"]);
      return {
        id: str(r["id"]),
        text: str(r["text"]),
        score: num(r["score"]),
        ...(ingestedAt !== null && ingestedAt !== undefined ? { ingestedAt: num(ingestedAt) } : {}),
        ...(metaStr !== null ? { metadata: JSON.parse(metaStr) as Record<string, unknown> } : {}),
      };
    });
  }

  async listMemory(scope: Scope) {
    const rs = await this.client.execute({
      sql: `SELECT memories.ext_id AS id, memories.text AS text, mm.ingested_at, mm.metadata
            FROM memories
            LEFT JOIN memory_meta mm ON mm.scope_key = memories.scope_key AND mm.ext_id = memories.ext_id
            WHERE memories.scope_key = ? ORDER BY memories.ext_id`,
      args: [scopeKey(scope)],
    });
    return rs.rows.map((row) => {
      const ingestedAt = row["ingested_at"];
      const metadata = strOrNull(row["metadata"]);
      return {
        id: str(row["id"]),
        text: str(row["text"]),
        ...(ingestedAt !== null && ingestedAt !== undefined ? { ingestedAt: num(ingestedAt) } : {}),
        ...(metadata !== null ? { metadata: JSON.parse(metadata) as Record<string, unknown> } : {}),
      };
    });
  }

  async deleteMemory(scope: Scope, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const sk = scopeKey(scope);
    let deleted = 0;
    for (const id of new Set(ids)) {
      const [memoryResult] = await this.client.batch([
        { sql: `DELETE FROM memories WHERE scope_key = ? AND ext_id = ?`, args: [sk, id] },
        { sql: `DELETE FROM memory_meta WHERE scope_key = ? AND ext_id = ?`, args: [sk, id] },
      ], "write");
      deleted += memoryResult?.rowsAffected ?? 0;
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Graph (Facts)
  // ---------------------------------------------------------------------------

  private rowToFact(r: import("@libsql/client").Row): Fact {
    const validUntil = strOrNull(r["valid_until"]);
    const source = strOrNull(r["source"]);
    const expiresAt = strOrNull(r["expires_at"]);
    const supersedes = strOrNull(r["supersedes"]);
    const lastCorroboratedAt = numOrNull(r["last_corroborated_at"]);
    return {
      id: str(r["id"]),
      subject: str(r["subject"]),
      predicate: str(r["predicate"]),
      object: str(r["object"]),
      objectKind: str(r["object_kind"]) as "entity" | "literal",
      validFrom: str(r["valid_from"]),
      ...(validUntil !== null ? { validUntil } : {}),
      confidence: num(r["confidence"]),
      ...(source !== null ? { source } : {}),
      ...(expiresAt !== null ? { expiresAt } : {}),
      ...(supersedes !== null ? { supersedes } : {}),
      ...(lastCorroboratedAt !== null ? { lastCorroboratedAt } : {}),
    };
  }

  async assertFact(
    scope: Scope,
    input: AssertFactInput,
  ): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    // Serialize same-instance calls to avoid needless local lock contention. The database
    // transaction in _assertFactBody is the actual cross-instance correctness boundary.
    //
    // Why not use client.transaction("write") (interactive transactions)?  The
    // @libsql/client sqlite3 driver sets its internal db reference to null after
    // every client.transaction() call so that the next operation gets a fresh
    // connection.  For :memory: databases a fresh connection is an empty database, so
    // any operation that follows the transaction (e.g. queryFacts) would fail with
    // "no such table".  client.batch() does not exhibit this behaviour.
    const prev = this.assertFactMutex;
    let release!: () => void;
    this.assertFactMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev; // wait for any in-flight assertFact to complete

    try {
      return await this._assertFactBody(scope, input);
    } finally {
      release();
    }
  }

  private async _assertFactBody(
    scope: Scope,
    input: AssertFactInput,
  ): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    const key = scopeKey(scope);
    const validFrom = input.validFrom ?? this.graphNow();
    const objectKind = input.objectKind ?? "literal";
    const confidence = input.confidence ?? 1;
    const source = input.source ?? null;
    const id = this.newFactId();
    const expiresAt =
      input.ttlMs !== undefined
        ? new Date(new Date(validFrom).getTime() + input.ttlMs).toISOString()
        : (input.expiresAt ?? null);
    const lastCorroboratedRaw = input.lastCorroboratedAt ?? Date.parse(validFrom);
    const lastCorroboratedAt = Number.isNaN(lastCorroboratedRaw) ? null : lastCorroboratedRaw;

    // BEGIN IMMEDIATE is acquired before the first SELECT in a "write" batch. A candidate is
    // inserted as non-current, the old row is invalidated, then the candidate is activated.
    // Other connections observe either the entire transition or none of it, and the partial
    // unique index remains valid at every statement boundary.
    const results = await this.client.batch([
      {
        sql: `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
              FROM facts WHERE scope_key = ? AND subject = ? AND predicate = ? AND valid_until IS NULL`,
        args: [key, input.subject, input.predicate],
      },
      {
        sql: `WITH current AS (
                SELECT id, object, valid_from
                FROM facts
                WHERE scope_key = ? AND subject = ? AND predicate = ? AND valid_until IS NULL
              )
              INSERT INTO facts
                (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                CASE WHEN (SELECT COUNT(*) FROM current) = 1
                  THEN (SELECT id FROM current LIMIT 1)
                  ELSE NULL
                END,
                ?
              WHERE NOT EXISTS (SELECT 1 FROM current WHERE object = ?)
                AND NOT EXISTS (SELECT 1 FROM current WHERE valid_from > ?)`,
        args: [
          key, input.subject, input.predicate,
          id, key, input.subject, input.predicate, input.object, objectKind, validFrom,
          validFrom, confidence, source, expiresAt, lastCorroboratedAt,
          input.object, validFrom,
        ],
      },
      {
        sql: `UPDATE facts
              SET valid_until = ?
              WHERE scope_key = ? AND subject = ? AND predicate = ?
                AND valid_until IS NULL AND id <> ?
                AND EXISTS (
                  SELECT 1 FROM facts AS candidate
                  WHERE candidate.id = ? AND candidate.valid_until = ?
                )`,
        args: [validFrom, key, input.subject, input.predicate, id, id, validFrom],
      },
      {
        sql: `UPDATE facts SET valid_until = NULL WHERE id = ? AND valid_until = ?`,
        args: [id, validFrom],
      },
    ] satisfies Stmt[], "write");

    const current = results[0]!.rows;
    const inserted = results[1]!.rowsAffected === 1;

    // Preserve the public idempotency and temporal-order semantics, but evaluate them against
    // the snapshot protected by the same write transaction as the transition.
    const sameRow = current.find((r) => str(r["object"]) === input.object);
    if (sameRow) {
      return { asserted: this.rowToFact(sameRow), invalidated: [] };
    }
    for (const r of current) {
      if (validFrom < str(r["valid_from"])) {
        throw new Error(
          `temporal order violation: validFrom '${validFrom}' is earlier than the current fact's validFrom '${str(r["valid_from"])}'`,
        );
      }
    }
    if (!inserted) {
      throw new Error("current-fact transition was rejected by the database invariant");
    }

    // State-transition link: when exactly one prior fact was superseded, record its id.
    const supersedes = current.length === 1 ? str(current[0]!["id"]) : null;

    const invalidated: Fact[] = current.map((r) =>
      this.rowToFact({ ...r, valid_until: validFrom }),
    );

    const asserted: Fact = {
      id,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      objectKind,
      validFrom,
      confidence,
      ...(source !== null ? { source } : {}),
      ...(expiresAt !== null ? { expiresAt } : {}),
      ...(supersedes !== null ? { supersedes } : {}),
      ...(lastCorroboratedAt !== null ? { lastCorroboratedAt } : {}),
    };
    return { asserted, invalidated };
  }

  async factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    return this.queryFacts({ scope, subject, predicate, includeInvalidated: true });
  }

  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    const ts = at ?? Date.now();
    const rs = await this.client.execute({
      sql: `UPDATE facts SET last_corroborated_at = ? WHERE scope_key = ? AND id = ? AND valid_until IS NULL`,
      args: [ts, scopeKey(scope), factId],
    });
    return rs.rowsAffected;
  }

  async expireFacts(scope: Scope, ids: string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const rs = await this.client.execute({
      sql: `UPDATE facts SET valid_until = ? WHERE scope_key = ? AND valid_until IS NULL AND id IN (${placeholders})`,
      args: [at, scopeKey(scope), ...ids],
    });
    return rs.rowsAffected;
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const key = scopeKey(query.scope);
    const where: string[] = ["scope_key = ?"];
    const args: import("@libsql/client").InValue[] = [key];

    if (query.subject !== undefined) { where.push("subject = ?"); args.push(query.subject); }
    if (query.predicate !== undefined) { where.push("predicate = ?"); args.push(query.predicate); }
    if (query.object !== undefined) { where.push("object = ?"); args.push(query.object); }

    if (query.validAt !== undefined) {
      where.push("valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)");
      args.push(query.validAt, query.validAt);
    } else if (!query.includeInvalidated) {
      where.push("valid_until IS NULL");
    }

    let limitClause = "";
    if (query.limit !== undefined) {
      // Bind limit as a positional parameter to prevent SQL injection.
      const safeLimit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : 100;
      limitClause = " LIMIT ?";
      args.push(safeLimit);
    }
    const rs = await this.client.execute({
      sql: `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
            FROM facts WHERE ${where.join(" AND ")} ORDER BY valid_from ASC${limitClause}`,
      args,
    });
    return rs.rows.map((r) => this.rowToFact(r));
  }

  async sweepExpired(scope: Scope, now: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `UPDATE facts SET valid_until = ? WHERE scope_key = ? AND valid_until IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`,
      args: [now, scopeKey(scope), now],
    });
    return rs.rowsAffected;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string; apiKey?: string }): Promise<SessionRecord[]> {
    const args: import("@libsql/client").InValue[] = [];
    const conditions: string[] = [];
    if (opts?.agentId !== undefined) {
      conditions.push("agent_id = ?");
      args.push(opts.agentId);
    }
    // Fix 2: strict filter — only exact matches when a principal filter is given.
    if (opts?.userId !== undefined) {
      conditions.push("user_id = ?");
      args.push(opts.userId);
    }
    if (opts?.orgId !== undefined) {
      conditions.push("org_id = ?");
      args.push(opts.orgId);
    }
    if (opts?.apiKey !== undefined) {
      conditions.push("api_key = ?");
      args.push(opts.apiKey);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let sql = `SELECT id, agent_id, created_at, user_id, org_id, api_key FROM sessions ${where} ORDER BY created_at DESC`;
    if (opts?.limit !== undefined) {
      // Bind limit as a positional parameter to prevent SQL injection.
      const safeLimit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 100;
      sql += " LIMIT ?";
      args.push(safeLimit);
    }
    const rs = await this.client.execute({ sql, args });
    return rs.rows.map((r) => {
      const userId = strOrNull(r["user_id"]);
      const orgId = strOrNull(r["org_id"]);
      const apiKey = strOrNull(r["api_key"]);
      return {
        id: str(r["id"]),
        agentId: str(r["agent_id"]),
        createdAt: str(r["created_at"]),
        ...(userId !== null ? { userId } : {}),
        ...(orgId !== null ? { orgId } : {}),
        ...(apiKey !== null ? { apiKey } : {}),
      };
    });
  }

  async listBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const rs = await this.client.execute({
      sql: `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ?`,
      args: [scopeKey(scope)],
    });
    return rs.rows.map((r) => ({
      label: str(r["label"]),
      value: str(r["value"]),
      version: num(r["version"]),
      updatedAt: str(r["updated_at"]),
    }));
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const key = scopeKey(scope);
    const stmts: Stmt[] = [
      { sql: `DELETE FROM facts WHERE scope_key = ?`, args: [key] },
      { sql: `DELETE FROM memories WHERE scope_key = ?`, args: [key] },
      { sql: `DELETE FROM memory_meta WHERE scope_key = ?`, args: [key] },
      { sql: `DELETE FROM block_history WHERE scope_key = ?`, args: [key] },
      { sql: `DELETE FROM blocks WHERE scope_key = ?`, args: [key] },
      { sql: `DELETE FROM idempotency_keys WHERE scope_key = ?`, args: [key] },
    ];
    const selection = sessionSelection(scope);
    if (selection) {
      const selectedSessions = `SELECT id FROM sessions WHERE ${selection.where}`;
      stmts.push(
        { sql: `DELETE FROM idempotency_keys WHERE session_id IN (${selectedSessions})`, args: selection.args },
        { sql: `DELETE FROM suspension_decisions WHERE session_id IN (${selectedSessions})`, args: selection.args },
        { sql: `DELETE FROM checkpoints WHERE session_id IN (${selectedSessions})`, args: selection.args },
        { sql: `DELETE FROM events WHERE session_id IN (${selectedSessions})`, args: selection.args },
        { sql: `DELETE FROM sessions WHERE ${selection.where}`, args: selection.args },
      );
    }

    const results = await this.client.batch(stmts, "write");
    const deleted = results.reduce((sum, r) => sum + r.rowsAffected, 0);
    return { deleted };
  }

  // ---------------------------------------------------------------------------
  // Durable (checkpoints + idempotency + suspension decisions)
  // ---------------------------------------------------------------------------

  async writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO checkpoints (session_id, seq, hash, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, seq) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at`,
      args: [sessionId, seq, hash, this.graphNow()],
    });
  }

  async lastCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const rs = await this.client.execute({
      sql: `SELECT session_id, seq, hash, created_at FROM checkpoints WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
      args: [sessionId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      sessionId: str(row["session_id"]),
      seq: num(row["seq"]),
      hash: str(row["hash"]),
      createdAt: str(row["created_at"]),
    };
  }

  async recordIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<void> {
    // Intent lifecycle fields are write-once; missing ownership metadata may be enriched but never reassigned.
    await this.client.batch([
      {
        sql: `INSERT OR IGNORE INTO idempotency_keys
          (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
          VALUES (?, ?, 'intent', NULL, ?, ?, ?, ?)`,
        args: [key, argsHash, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null],
      },
      {
        sql: `UPDATE idempotency_keys SET
          scope_key = COALESCE(scope_key, ?), session_id = COALESCE(session_id, ?), owner_key = COALESCE(owner_key, ?)
          WHERE key = ?`,
        args: [metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null, key],
      },
    ], "write");
  }

  async claimIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean> {
    const result = await this.client.execute({
      sql: `INSERT OR IGNORE INTO idempotency_keys
        (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
        VALUES (?, ?, 'intent', NULL, ?, ?, ?, ?)`,
      args: [key, argsHash, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null],
    });
    return result.rowsAffected === 1;
  }

  async releaseIntent(key: string, argsHash: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `DELETE FROM idempotency_keys WHERE key = ? AND args_hash = ? AND status = 'intent'`,
      args: [key, argsHash],
    });
    return result.rowsAffected === 1;
  }

  async recordCompletion(key: string, result: unknown, metadata?: IdempotencyMetadata): Promise<void> {
    const serialized = JSON.stringify(result ?? null);
    // Ensure row exists (covers completion without a prior intent), then flip to applied.
    // Both operations in a single batch for atomicity.
    await this.client.batch(
      [
        {
          sql: `INSERT OR IGNORE INTO idempotency_keys
            (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
            VALUES (?, '', 'intent', NULL, ?, ?, ?, ?)`,
          args: [key, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null],
        },
        {
          sql: `UPDATE idempotency_keys SET status = 'applied', result = ?,
            scope_key = COALESCE(scope_key, ?), session_id = COALESCE(session_id, ?), owner_key = COALESCE(owner_key, ?)
            WHERE key = ?`,
          args: [serialized, metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null, key],
        },
      ],
      "write",
    );
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const rs = await this.client.execute({
      sql: `SELECT key, args_hash, status, result, created_at, scope_key, session_id, owner_key FROM idempotency_keys WHERE key = ?`,
      args: [key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    const resultStr = strOrNull(row["result"]);
    const scopeKeyValue = strOrNull(row["scope_key"]);
    const sessionId = strOrNull(row["session_id"]);
    const ownerKey = strOrNull(row["owner_key"]);
    return {
      key: str(row["key"]),
      argsHash: str(row["args_hash"]),
      status: str(row["status"]) as IdempotencyStatus,
      ...(resultStr !== null ? { result: JSON.parse(resultStr) } : {}),
      createdAt: str(row["created_at"]),
      ...(scopeKeyValue !== null ? { scopeKey: scopeKeyValue } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(ownerKey !== null ? { ownerKey } : {}),
    };
  }

  async recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void> {
    const serialized = JSON.stringify(decision);
    await this.client.execute({
      sql: `INSERT INTO suspension_decisions (session_id, call_id, decision, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, call_id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
      args: [sessionId, callId, serialized, this.graphNow()],
    });
  }

  async getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null> {
    const rs = await this.client.execute({
      sql: `SELECT decision FROM suspension_decisions WHERE session_id = ? AND call_id = ?`,
      args: [sessionId, callId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(str(row["decision"])) as SuspendDecision;
  }
}
