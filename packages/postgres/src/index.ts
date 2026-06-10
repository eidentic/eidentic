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
  type IdempotencyStatus,
  type SuspendDecision,
} from "@eidentic/types";
import { runMigrations } from "./migrations.js";

/** Minimal client surface satisfied by both `pg.Pool` and `@electric-sql/pglite`. */
export interface PgClient {
  /**
   * Execute a parameterised query.
   *
   * Supply a row type parameter `R` to get compile-time column checking:
   * ```ts
   * const { rows } = await client.query<{ id: string; name: string }>(
   *   "SELECT id, name FROM users WHERE id = $1", [userId],
   * );
   * // rows is { id: string; name: string }[]
   * ```
   *
   * The default is `any` for back-compat — untyped callers continue to work
   * without changes, while new call-sites can opt in to typed rows.
   */
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Present on `pg.Pool` and `pg.Client`; absent on pglite. */
  connect?(): Promise<PgPoolClient>;
}

/** Minimal surface of the dedicated client checked out from a `pg.Pool`. */
export interface PgPoolClient {
  /** @see {@link PgClient.query} */
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  release(): void;
}

/** Coerce a Postgres value to string. Handles string/number/null from various drivers. */
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Coerce a Postgres value to number. */
function num(v: unknown): number {
  return Number(v);
}

/** Coerce a nullable Postgres value to string | null. */
function strNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Turn arbitrary user text into a safe `websearch_to_tsquery` OR expression.
 * Each token is lexeme-safe (output of `tokenize` contains only word chars).
 * Returns null if no tokens.
 * Example: "alpha beta" → "alpha or beta" → websearch_to_tsquery('english', 'alpha or beta')
 * We join tokens with `or` to match the sqlite FTS5 `"alpha" OR "beta"` behaviour.
 * `websearch_to_tsquery` (unlike `to_tsquery`) never raises on empty / all-stop-word input —
 * it yields an empty tsquery that simply matches nothing, instead of a syntax error.
 */
function ftsOr(text: string): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  // tokens from tokenize() contain only word characters; `or` is the websearch OR operator.
  return tokens.join(" or ");
}

export class PostgresStore implements StorePort, GraphPort, DurablePort {
  private factIdCounter = 0;
  private readonly newFactId: () => string;
  private readonly graphNow: () => string;

  /**
   * Construct a PostgresStore wrapping an injected `PgClient`.
   *
   * Pass a `pg.Pool` or a `@electric-sql/pglite` instance as `client`.
   * Note: when using `pg.Pool`, pass a dedicated client or pool — the store
   * issues its own BEGIN/COMMIT on the connection for multi-statement atomicity.
   * For pglite (single-connection WASM), BEGIN/COMMIT on the same client is fine.
   *
   * Call `await store.migrate()` before use, or use `PostgresStore.create()`
   * which runs migrations automatically.
   */
  constructor(
    private readonly client: PgClient,
    opts?: { newId?: () => string; now?: () => string },
  ) {
    this.newFactId = opts?.newId ?? (() => `fact_${Date.now().toString(36)}_${(this.factIdCounter++).toString(36)}`);
    this.graphNow = opts?.now ?? (() => new Date().toISOString());
  }

  /**
   * Create a PostgresStore and run migrations in one step.
   * Convenience wrapper for `new PostgresStore(client)` + `migrate()`.
   */
  static async create(
    opts: { client: PgClient; newId?: () => string; now?: () => string },
  ): Promise<PostgresStore> {
    const store = new PostgresStore(opts.client, { newId: opts.newId, now: opts.now });
    await runMigrations(opts.client);
    return store;
  }

  async migrate(): Promise<void> {
    await runMigrations(this.client);
  }

  async close(): Promise<void> {
    // No-op: the injected client is owned by the caller; they manage its lifecycle.
  }

  /**
   * Run `fn` inside a single Postgres transaction.
   *
   * When `this.client` is a `pg.Pool` (has a `connect()` method), we check out
   * a dedicated connection so that BEGIN / body / COMMIT all execute on the same
   * underlying socket — Pool.query() would otherwise dispatch each call to a
   * different pooled connection, destroying atomicity.
   *
   * When `this.client` is pglite (no `connect()`), the client IS the connection;
   * we issue BEGIN/COMMIT directly on it, matching the previous behaviour.
   */
  private async withTransaction<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
    if (typeof this.client.connect === "function") {
      // Pool path: check out a single dedicated client.
      const c = await this.client.connect();
      try {
        await c.query("BEGIN");
        try {
          const result = await fn(c);
          await c.query("COMMIT");
          return result;
        } catch (err) {
          try { await c.query("ROLLBACK"); } catch { /* ignore rollback error */ }
          throw err;
        }
      } finally {
        c.release();
      }
    } else {
      // Single-connection path (pglite).
      await this.client.query("BEGIN");
      try {
        const result = await fn(this.client);
        await this.client.query("COMMIT");
        return result;
      } catch (err) {
        try { await this.client.query("ROLLBACK"); } catch { /* ignore rollback error */ }
        throw err;
      }
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(s: SessionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO sessions (id, agent_id, created_at, user_id, org_id) VALUES ($1, $2, $3, $4, $5)`,
      [s.id, s.agentId, s.createdAt, s.userId ?? null, s.orgId ?? null],
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.client.query(
      `SELECT id, agent_id, created_at, user_id, org_id FROM sessions WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const userId = strNull(row.user_id);
    const orgId = strNull(row.org_id);
    return {
      id: str(row.id),
      agentId: str(row.agent_id),
      createdAt: str(row.created_at),
      ...(userId !== null ? { userId } : {}),
      ...(orgId !== null ? { orgId } : {}),
    };
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async appendEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.withTransaction(async (c) => {
        for (const e of events) {
          await c.query(
            `INSERT INTO events (id, session_id, seq, kind, schema_version, payload, meta, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              e.id,
              e.sessionId,
              e.seq,
              e.kind,
              e.schemaVersion,
              JSON.stringify(e.payload),
              e.meta !== undefined ? JSON.stringify(e.meta) : null,
              e.createdAt,
            ],
          );
        }
      });
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique constraint|conflict/i.test(err.message)) {
        throw new StoreConflictError(`conflict: ${err.message}`);
      }
      throw err;
    }
  }

  async readEvents(sessionId: string): Promise<StoredEvent[]> {
    const { rows } = await this.client.query(
      `SELECT id, session_id, seq, kind, schema_version, payload, meta, created_at
       FROM events WHERE session_id = $1 ORDER BY seq ASC`,
      [sessionId],
    );
    return rows.map((r) => ({
      id: str(r.id),
      sessionId: str(r.session_id),
      seq: num(r.seq),
      kind: str(r.kind) as StoredEvent["kind"],
      schemaVersion: num(r.schema_version),
      payload: JSON.parse(str(r.payload)),
      meta: r.meta !== null && r.meta !== undefined ? JSON.parse(str(r.meta)) : undefined,
      createdAt: str(r.created_at),
    }));
  }

  // ── Blocks ────────────────────────────────────────────────────────────────

  async getBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const { rows } = await this.client.query(
      `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = $1`,
      [scopeKey(scope)],
    );
    return rows.map((r) => ({
      label: str(r.label),
      value: str(r.value),
      version: num(r.version),
      updatedAt: str(r.updated_at),
    }));
  }

  async getBlock(scope: Scope, label: string): Promise<MemoryBlock | null> {
    const { rows } = await this.client.query(
      `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = $1 AND label = $2`,
      [scopeKey(scope), label],
    );
    const row = rows[0];
    if (!row) return null;
    return { label: str(row.label), value: str(row.value), version: num(row.version), updatedAt: str(row.updated_at) };
  }

  async upsertBlock(scope: Scope, block: { label: string; value: string }, expectVersion?: number): Promise<MemoryBlock> {
    const key = scopeKey(scope);
    const now = new Date().toISOString();
    try {
      return await this.withTransaction(async (c) => {
        const { rows: existing } = await c.query(
          `SELECT version FROM blocks WHERE scope_key = $1 AND label = $2`,
          [key, block.label],
        );
        const cur = existing[0];
        if (expectVersion !== undefined && !cur) {
          throw new StoreConflictError(
            `conflict: block ${block.label} expected version ${expectVersion} but it does not exist`,
          );
        }
        if (expectVersion !== undefined && cur && num(cur.version) !== expectVersion) {
          throw new StoreConflictError(
            `conflict: block ${block.label} version ${num(cur.version)} != expected ${expectVersion}`,
          );
        }
        const version = cur ? num(cur.version) + 1 : 0;
        return await this.writeBlock(c, key, block.label, block.value, version, now);
      });
    } catch (err) {
      throw err;
    }
  }

  async appendBlock(scope: Scope, label: string, text: string): Promise<MemoryBlock> {
    const key = scopeKey(scope);
    const now = new Date().toISOString();
    return this.withTransaction(async (c) => {
      const { rows: existing } = await c.query(
        `SELECT value, version FROM blocks WHERE scope_key = $1 AND label = $2`,
        [key, label],
      );
      const cur = existing[0];
      const value = (cur ? str(cur.value) : "") + text;
      const version = cur ? num(cur.version) + 1 : 0;
      return this.writeBlock(c, key, label, value, version, now);
    });
  }

  async getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]> {
    const { rows } = await this.client.query(
      `SELECT label, value, version, updated_at FROM block_history
       WHERE scope_key = $1 AND label = $2 ORDER BY version ASC`,
      [scopeKey(scope), label],
    );
    return rows.map((r) => ({
      label: str(r.label),
      value: str(r.value),
      version: num(r.version),
      updatedAt: str(r.updated_at),
    }));
  }

  private async writeBlock(
    c: PgClient, scopeKeyStr: string, label: string, value: string, version: number, now: string,
  ): Promise<MemoryBlock> {
    await c.query(
      `INSERT INTO blocks (scope_key, label, value, version, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope_key, label) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
      [scopeKeyStr, label, value, version, now],
    );
    await c.query(
      `INSERT INTO block_history (scope_key, label, version, value, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope_key, label, version) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [scopeKeyStr, label, version, value, now],
    );
    return { label, value, version, updatedAt: now };
  }

  // ── Memory (FTS via tsvector + ts_rank) ────────────────────────────────────

  async indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>): Promise<void> {
    if (entries.length === 0) return;
    await this.withTransaction(async (c) => {
      for (const e of entries) {
        await c.query(
          `INSERT INTO memories (scope_key, ext_id, text, ingested_at, metadata) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (scope_key, ext_id) DO UPDATE SET
             text = EXCLUDED.text,
             ingested_at = COALESCE(EXCLUDED.ingested_at, memories.ingested_at),
             metadata = COALESCE(EXCLUDED.metadata, memories.metadata)`,
          [
            scopeKey(e.scope),
            e.id,
            e.text,
            e.ingestedAt ?? null,
            e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
          ],
        );
      }
    });
  }

  async searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]> {
    const tsExpr = ftsOr(query);
    if (!tsExpr) return [];
    // websearch_to_tsquery('english', $1) where $1 is "token1 or token2 or ..." (OR semantics,
    // mirrors SQLite FTS5 OR). Unlike to_tsquery it tolerates all-stop-word input (→ empty
    // tsquery → no match) instead of raising. tokenize() guarantees word-only tokens.
    const { rows } = await this.client.query(
      `SELECT ext_id AS id, text, ts_rank(tsv, websearch_to_tsquery('english', $1)) AS score,
              ingested_at, metadata
       FROM memories
       WHERE scope_key = $2 AND tsv @@ websearch_to_tsquery('english', $1)
       ORDER BY score DESC
       LIMIT $3`,
      [tsExpr, scopeKey(scope), topK],
    );
    return rows
      .map((r) => ({
        id: str(r.id),
        text: str(r.text),
        score: num(r.score),
        ...(r.ingested_at !== null && r.ingested_at !== undefined ? { ingestedAt: num(r.ingested_at) } : {}),
        ...(r.metadata !== null && r.metadata !== undefined
          ? { metadata: (typeof r.metadata === "object" ? r.metadata : JSON.parse(str(r.metadata))) as Record<string, unknown> }
          : {}),
      }))
      .filter((r) => r.score > 0);
  }

  // ── Graph (Facts) ──────────────────────────────────────────────────────────

  private rowToFact(r: {
    id: unknown; subject: unknown; predicate: unknown; object: unknown; object_kind: unknown;
    valid_from: unknown; valid_until: unknown; confidence: unknown; source: unknown; expires_at: unknown;
    supersedes?: unknown; last_corroborated_at?: unknown;
  }): Fact {
    // BIGINT comes back from the pg driver as a string; coerce to number.
    const lastCorr = r.last_corroborated_at !== null && r.last_corroborated_at !== undefined
      ? Number(r.last_corroborated_at)
      : null;
    return {
      id: str(r.id),
      subject: str(r.subject),
      predicate: str(r.predicate),
      object: str(r.object),
      objectKind: str(r.object_kind) as "entity" | "literal",
      validFrom: str(r.valid_from),
      ...(r.valid_until !== null && r.valid_until !== undefined ? { validUntil: str(r.valid_until) } : {}),
      confidence: num(r.confidence),
      ...(r.source !== null && r.source !== undefined ? { source: str(r.source) } : {}),
      ...(r.expires_at !== null && r.expires_at !== undefined ? { expiresAt: str(r.expires_at) } : {}),
      ...(r.supersedes !== null && r.supersedes !== undefined ? { supersedes: str(r.supersedes) } : {}),
      ...(lastCorr !== null && !Number.isNaN(lastCorr) ? { lastCorroboratedAt: lastCorr } : {}),
    };
  }

  async assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    const key = scopeKey(scope);
    const validFrom = input.validFrom ?? this.graphNow();
    const objectKind = input.objectKind ?? "literal";
    const confidence = input.confidence ?? 1;
    const source = input.source ?? null;
    const id = this.newFactId();
    const expiresAt = input.ttlMs !== undefined
      ? new Date(new Date(validFrom).getTime() + input.ttlMs).toISOString()
      : (input.expiresAt ?? null);
    const lastCorroboratedRaw = input.lastCorroboratedAt ?? Date.parse(validFrom);
    const lastCorroboratedAt = Number.isNaN(lastCorroboratedRaw) ? null : lastCorroboratedRaw;

    return this.withTransaction(async (c) => {
      const { rows: current } = await c.query(
        `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
         FROM facts WHERE scope_key = $1 AND subject = $2 AND predicate = $3 AND valid_until IS NULL`,
        [key, input.subject, input.predicate],
      );

      const same = current.find((r) => str(r.object) === input.object);
      if (same) {
        return { asserted: this.rowToFact(same), invalidated: [] };
      }

      // Guard: new validFrom must not precede any currently-valid prior fact's validFrom.
      for (const r of current) {
        if (validFrom < str(r.valid_from)) {
          throw new Error(
            `temporal order violation: validFrom '${validFrom}' is earlier than the current fact's validFrom '${str(r.valid_from)}'`,
          );
        }
      }

      const invalidated: Fact[] = [];
      for (const r of current) {
        await c.query(`UPDATE facts SET valid_until = $1 WHERE id = $2`, [validFrom, str(r.id)]);
        invalidated.push(this.rowToFact({ ...r, valid_until: validFrom }));
      }
      // State-transition link: when exactly one prior fact was superseded, record its id.
      const supersedes = current.length === 1 ? str(current[0].id) : null;

      await c.query(
        `INSERT INTO facts (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12)`,
        [id, key, input.subject, input.predicate, input.object, objectKind, validFrom, confidence, source, expiresAt, supersedes, lastCorroboratedAt],
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
    });
  }

  async factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    return this.queryFacts({ scope, subject, predicate, includeInvalidated: true });
  }

  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    const ts = at ?? Date.now();
    const { rows } = await this.client.query(
      `UPDATE facts SET last_corroborated_at = $1 WHERE scope_key = $2 AND id = $3 AND valid_until IS NULL RETURNING id`,
      [ts, scopeKey(scope), factId],
    );
    return rows.length;
  }

  async expireFacts(scope: Scope, ids: string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, i) => `$${i + 3}`).join(", ");
    const { rows } = await this.client.query(
      `UPDATE facts SET valid_until = $1 WHERE scope_key = $2 AND valid_until IS NULL AND id IN (${placeholders}) RETURNING id`,
      [at, scopeKey(scope), ...ids],
    );
    return rows.length;
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const key = scopeKey(query.scope);
    const conditions: string[] = ["scope_key = $1"];
    const params: unknown[] = [key];
    let idx = 2;

    if (query.subject !== undefined) { conditions.push(`subject = $${idx++}`); params.push(query.subject); }
    if (query.predicate !== undefined) { conditions.push(`predicate = $${idx++}`); params.push(query.predicate); }
    if (query.object !== undefined) { conditions.push(`object = $${idx++}`); params.push(query.object); }
    if (query.validAt !== undefined) {
      conditions.push(`valid_from <= $${idx} AND (valid_until IS NULL OR valid_until > $${idx})`);
      params.push(query.validAt);
      idx++;
    } else if (!query.includeInvalidated) {
      conditions.push("valid_until IS NULL");
    }

    let limitClause = "";
    if (query.limit !== undefined) {
      // Bind limit as a numbered parameter to prevent SQL injection.
      const safeLimit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : 100;
      limitClause = ` LIMIT $${idx}`;
      params.push(safeLimit);
      idx++;
    }
    const { rows } = await this.client.query(
      `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
       FROM facts WHERE ${conditions.join(" AND ")} ORDER BY valid_from ASC${limitClause}`,
      params,
    );
    return rows.map((r) => this.rowToFact(r));
  }

  async sweepExpired(scope: Scope, now: string): Promise<number> {
    const { rows } = await this.client.query(
      `UPDATE facts SET valid_until = $1
       WHERE scope_key = $2 AND valid_until IS NULL AND expires_at IS NOT NULL AND expires_at <= $1
       RETURNING id`,
      [now, scopeKey(scope)],
    );
    return rows.length;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string }): Promise<SessionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts?.agentId !== undefined) {
      conditions.push(`agent_id = $${idx++}`);
      params.push(opts.agentId);
    }
    // Fix 2: strict filter — only exact matches when a principal filter is given.
    if (opts?.userId !== undefined) {
      conditions.push(`user_id = $${idx++}`);
      params.push(opts.userId);
    }
    if (opts?.orgId !== undefined) {
      conditions.push(`org_id = $${idx++}`);
      params.push(opts.orgId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let limitClause = "";
    if (opts?.limit !== undefined) {
      // Bind limit as a numbered parameter to prevent SQL injection.
      const safeLimit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 100;
      limitClause = ` LIMIT $${idx}`;
      params.push(safeLimit);
    }
    const { rows } = await this.client.query(
      `SELECT id, agent_id, created_at, user_id, org_id FROM sessions ${where} ORDER BY created_at DESC${limitClause}`,
      params,
    );
    return rows.map((r) => {
      const userId = strNull(r.user_id);
      const orgId = strNull(r.org_id);
      return {
        id: str(r.id),
        agentId: str(r.agent_id),
        createdAt: str(r.created_at),
        ...(userId !== null ? { userId } : {}),
        ...(orgId !== null ? { orgId } : {}),
      };
    });
  }

  async listBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const { rows } = await this.client.query(
      `SELECT label, value, version, updated_at FROM blocks WHERE scope_key = $1`,
      [scopeKey(scope)],
    );
    return rows.map((r) => ({
      label: str(r.label),
      value: str(r.value),
      version: num(r.version),
      updatedAt: str(r.updated_at),
    }));
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const key = scopeKey(scope);
    const agentId = "agentId" in scope ? (scope as { agentId: string }).agentId : null;
    return this.withTransaction(async (c) => {
      let deleted = 0;
      // Scope-keyed tables
      const { rows: f } = await c.query(`DELETE FROM facts WHERE scope_key = $1 RETURNING id`, [key]);
      deleted += f.length;
      const { rows: m } = await c.query(`DELETE FROM memories WHERE scope_key = $1 RETURNING ext_id`, [key]);
      deleted += m.length;
      const { rows: bh } = await c.query(`DELETE FROM block_history WHERE scope_key = $1 RETURNING label`, [key]);
      deleted += bh.length;
      const { rows: b } = await c.query(`DELETE FROM blocks WHERE scope_key = $1 RETURNING label`, [key]);
      deleted += b.length;
      // Sessions + events by agentId
      if (agentId !== null) {
        const { rows: sessions } = await c.query(`SELECT id FROM sessions WHERE agent_id = $1`, [agentId]);
        for (const sess of sessions) {
          const { rows: ev } = await c.query(`DELETE FROM events WHERE session_id = $1 RETURNING id`, [str(sess.id)]);
          deleted += ev.length;
        }
        const { rows: s } = await c.query(`DELETE FROM sessions WHERE agent_id = $1 RETURNING id`, [agentId]);
        deleted += s.length;
      }
      return { deleted };
    });
  }

  // ── Durable (Checkpoints + Idempotency + Suspension) ──────────────────────

  async writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void> {
    await this.client.query(
      `INSERT INTO checkpoints (session_id, seq, hash, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, seq) DO UPDATE SET hash = EXCLUDED.hash, created_at = EXCLUDED.created_at`,
      [sessionId, seq, hash, this.graphNow()],
    );
  }

  async lastCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const { rows } = await this.client.query(
      `SELECT session_id, seq, hash, created_at FROM checkpoints
       WHERE session_id = $1 ORDER BY seq DESC LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: str(row.session_id),
      seq: num(row.seq),
      hash: str(row.hash),
      createdAt: str(row.created_at),
    };
  }

  async recordIntent(key: string, argsHash: string): Promise<void> {
    // INSERT ... ON CONFLICT DO NOTHING: intent is write-once; an existing row is left untouched.
    await this.client.query(
      `INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES ($1, $2, 'intent', NULL, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, argsHash, this.graphNow()],
    );
  }

  async recordCompletion(key: string, result: unknown): Promise<void> {
    const serialized = JSON.stringify(result ?? null);
    await this.withTransaction(async (c) => {
      // Ensure a row exists (covers completion without a prior intent), then flip to applied.
      await c.query(
        `INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES ($1, '', 'intent', NULL, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, this.graphNow()],
      );
      await c.query(
        `UPDATE idempotency_keys SET status = 'applied', result = $1 WHERE key = $2`,
        [serialized, key],
      );
    });
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.client.query(
      `SELECT key, args_hash, status, result, created_at FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      key: str(row.key),
      argsHash: str(row.args_hash),
      status: str(row.status) as IdempotencyStatus,
      ...(row.result !== null && row.result !== undefined ? { result: JSON.parse(str(row.result)) } : {}),
      createdAt: str(row.created_at),
    };
  }

  async recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void> {
    const serialized = JSON.stringify(decision);
    await this.client.query(
      `INSERT INTO suspension_decisions (session_id, call_id, decision, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, call_id) DO UPDATE SET decision = EXCLUDED.decision, created_at = EXCLUDED.created_at`,
      [sessionId, callId, serialized, this.graphNow()],
    );
  }

  async getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null> {
    const { rows } = await this.client.query(
      `SELECT decision FROM suspension_decisions WHERE session_id = $1 AND call_id = $2`,
      [sessionId, callId],
    );
    const row = rows[0];
    if (!row) return null;
    return JSON.parse(str(row.decision)) as SuspendDecision;
  }
}
