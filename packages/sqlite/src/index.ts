import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import {
  StoreConflictError,
  legacyScopeKey,
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

/** Lazy loader for better-sqlite3: only fires when SqliteStore is constructed. */
function loadBetterSqlite(): typeof import("better-sqlite3") {
  try {
    // In a CJS bundle __filename is available; in native ESM import.meta.url is the stable base.
    // Do not probe `require`: esbuild's ESM require shim is a function but cannot load native CJS
    // addons, which made the published ESM entry fail at runtime.
    const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return req("better-sqlite3");
  } catch (e) {
    throw new Error(
      "better-sqlite3 is not available in this runtime. SqliteStore requires the native better-sqlite3 " +
      "addon (Node, and Bun where it builds). On Deno/edge/Workers use @eidentic/libsql (Turso) or " +
      "@eidentic/postgres instead. Original: " + (e as Error).message,
    );
  }
}

function sessionSelection(scope: Scope): { where: string; args: string[] } | null {
  if (scope.kind === "agent") return { where: "agent_id = ?", args: [scope.agentId] };
  if (scope.kind === "user") return { where: "agent_id = ? AND user_id = ?", args: [scope.agentId, scope.userId] };
  if (scope.kind === "org") return { where: "agent_id = ? AND org_id = ?", args: [scope.agentId, scope.orgId] };
  if (scope.kind === "thread") return { where: "agent_id = ? AND id = ?", args: [scope.agentId, scope.sessionId] };
  return null;
}

/** Turn arbitrary user text into a safe FTS5 MATCH expression (OR of quoted tokens), or null if no tokens. */
function ftsMatch(text: string): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  // Escape embedded double-quotes by doubling them (FTS5 quoted-token syntax).
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export class SqliteStore implements StorePort, GraphPort, DurablePort {
  private db: Database.Database;
  private factIdCounter = 0;
  private readonly newFactId: () => string;
  private readonly graphNow: () => string;
  constructor(path = ":memory:", opts?: { newId?: () => string; now?: () => string }) {
    const BetterSqlite = loadBetterSqlite();
    const DatabaseCtor = (BetterSqlite as unknown as { default?: typeof import("better-sqlite3") }).default ?? BetterSqlite;
    this.db = new (DatabaseCtor as unknown as new (path: string) => Database.Database)(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.newFactId = opts?.newId ?? (() => `fact_${Date.now().toString(36)}_${(this.factIdCounter++).toString(36)}`);
    this.graphNow = opts?.now ?? (() => new Date().toISOString());
  }

  async migrate() {
    runMigrations(this.db);
  }
  async indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>) {
    const delFts = this.db.prepare(`DELETE FROM memories WHERE scope_key = ? AND ext_id = ?`);
    const insFts = this.db.prepare(`INSERT INTO memories (scope_key, ext_id, text) VALUES (?, ?, ?)`);
    const delMeta = this.db.prepare(`DELETE FROM memory_meta WHERE scope_key = ? AND ext_id = ?`);
    const insMeta = this.db.prepare(
      `INSERT INTO memory_meta (scope_key, ext_id, ingested_at, metadata) VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>) => {
      for (const e of rows) {
        const sk = scopeKey(e.scope);
        delFts.run(sk, e.id);
        insFts.run(sk, e.id, e.text);
        if (e.ingestedAt !== undefined) {
          delMeta.run(sk, e.id);
          insMeta.run(sk, e.id, e.ingestedAt, e.metadata !== undefined ? JSON.stringify(e.metadata) : null);
        }
      }
    });
    tx(entries);
  }

  async searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]> {
    const match = ftsMatch(query);
    if (!match) return [];
    const sk = scopeKey(scope);
    // FTS5 bm25() requires the virtual table's own name (not an alias).
    // We first query the FTS table directly, then join memory_meta separately.
    const rows = this.db
      .prepare(
        `SELECT memories.ext_id AS id, memories.text AS text, -bm25(memories) AS score,
                mm.ingested_at, mm.metadata
         FROM memories
         LEFT JOIN memory_meta mm ON mm.scope_key = memories.scope_key AND mm.ext_id = memories.ext_id
         WHERE memories.scope_key = ? AND memories.text MATCH ?
         ORDER BY bm25(memories)
         LIMIT ?`,
      )
      .all(sk, match, topK) as Array<{ id: string; text: string; score: number; ingested_at: number | null; metadata: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      score: r.score,
      ...(r.ingested_at !== null ? { ingestedAt: r.ingested_at } : {}),
      ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> } : {}),
    }));
  }

  async listMemory(scope: Scope) {
    const rows = this.db.prepare(
      `SELECT memories.ext_id AS id, memories.text AS text, mm.ingested_at, mm.metadata
       FROM memories
       LEFT JOIN memory_meta mm ON mm.scope_key = memories.scope_key AND mm.ext_id = memories.ext_id
       WHERE memories.scope_key = ? ORDER BY memories.ext_id`,
    ).all(scopeKey(scope)) as Array<{ id: string; text: string; ingested_at: number | null; metadata: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      ...(row.ingested_at !== null ? { ingestedAt: row.ingested_at } : {}),
      ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
    }));
  }

  async deleteMemory(scope: Scope, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const sk = scopeKey(scope);
    const delMemory = this.db.prepare(`DELETE FROM memories WHERE scope_key = ? AND ext_id = ?`);
    const delMeta = this.db.prepare(`DELETE FROM memory_meta WHERE scope_key = ? AND ext_id = ?`);
    return this.db.transaction((targets: string[]) => {
      let deleted = 0;
      for (const id of new Set(targets)) {
        deleted += delMemory.run(sk, id).changes;
        delMeta.run(sk, id);
      }
      return deleted;
    })(ids);
  }

  async close() {
    this.db.close();
  }

  async createSession(s: SessionRecord) {
    this.db
      .prepare(`INSERT INTO sessions (id, agent_id, created_at, user_id, org_id, api_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.agentId, s.createdAt, s.userId ?? null, s.orgId ?? null, s.apiKey ?? null);
  }
  async getSession(id: string) {
    const row = this.db.prepare(`SELECT id, agent_id, created_at, user_id, org_id, api_key FROM sessions WHERE id = ?`).get(id) as
      | { id: string; agent_id: string; created_at: string; user_id: string | null; org_id: string | null; api_key: string | null }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      createdAt: row.created_at,
      ...(row.user_id !== null ? { userId: row.user_id } : {}),
      ...(row.org_id !== null ? { orgId: row.org_id } : {}),
      ...(row.api_key !== null ? { apiKey: row.api_key } : {}),
    };
  }
  async replaceSessionApiKey(sessionId: string, expected: string, replacement: string): Promise<boolean> {
    return this.db.prepare(`UPDATE sessions SET api_key = ? WHERE id = ? AND api_key = ?`)
      .run(replacement, sessionId, expected).changes === 1;
  }

  async appendEvents(events: StoredEvent[]) {
    const stmt = this.db.prepare(
      `INSERT INTO events (id, session_id, seq, kind, schema_version, payload, meta, created_at)
       VALUES (@id, @session_id, @seq, @kind, @schema_version, @payload, @meta, @created_at)`,
    );
    const tx = this.db.transaction((rows: StoredEvent[]) => {
      for (const e of rows) {
        stmt.run({
          id: e.id, session_id: e.sessionId, seq: e.seq, kind: e.kind,
          schema_version: e.schemaVersion, payload: JSON.stringify(e.payload),
          meta: e.meta ? JSON.stringify(e.meta) : null, created_at: e.createdAt,
        });
      }
    });
    try {
      tx(events);
    } catch (err) {
      if (err instanceof Error && /SQLITE_CONSTRAINT/.test((err as { code?: string }).code ?? "")) {
        throw new StoreConflictError(`conflict: ${err.message}`);
      }
      throw err;
    }
  }

  async readEvents(sessionId: string): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      seq: number;
      kind: string;
      schema_version: number;
      payload: string;
      meta: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      kind: r.kind as StoredEvent["kind"],
      schemaVersion: r.schema_version,
      payload: JSON.parse(r.payload),
      meta: r.meta ? JSON.parse(r.meta) : undefined,
      createdAt: r.created_at,
    }));
  }

  async getBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const rows = this.db
      .prepare(`SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ?`)
      .all(scopeKey(scope)) as Array<{ label: string; value: string; version: number; updated_at: string }>;
    return rows.map((r) => ({ label: r.label, value: r.value, version: r.version, updatedAt: r.updated_at }));
  }

  async getBlock(scope: Scope, label: string): Promise<MemoryBlock | null> {
    const row = this.db
      .prepare(`SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ? AND label = ?`)
      .get(scopeKey(scope), label) as { label: string; value: string; version: number; updated_at: string } | undefined;
    return row ? { label: row.label, value: row.value, version: row.version, updatedAt: row.updated_at } : null;
  }

  async upsertBlock(scope: Scope, block: { label: string; value: string }, expectVersion?: number) {
    const key = scopeKey(scope);
    const now = new Date().toISOString();
    const tx = this.db.transaction((): MemoryBlock => {
      const existing = this.db
        .prepare(`SELECT version FROM blocks WHERE scope_key = ? AND label = ?`)
        .get(key, block.label) as { version: number } | undefined;
      if (expectVersion !== undefined && !existing) {
        throw new StoreConflictError(`conflict: block ${block.label} expected version ${expectVersion} but it does not exist`);
      }
      if (expectVersion !== undefined && existing && existing.version !== expectVersion) {
        throw new StoreConflictError(
          `conflict: block ${block.label} version ${existing.version} != expected ${expectVersion}`,
        );
      }
      const version = existing ? existing.version + 1 : 0;
      return this.writeBlock(key, block.label, block.value, version, now);
    });
    return tx();
  }

  async appendBlock(scope: Scope, label: string, text: string) {
    const key = scopeKey(scope);
    const now = new Date().toISOString();
    const tx = this.db.transaction((): MemoryBlock => {
      const existing = this.db
        .prepare(`SELECT value, version FROM blocks WHERE scope_key = ? AND label = ?`)
        .get(key, label) as { value: string; version: number } | undefined;
      const value = (existing?.value ?? "") + text;
      const version = existing ? existing.version + 1 : 0;
      return this.writeBlock(key, label, value, version, now);
    });
    return tx();
  }

  async getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]> {
    const rows = this.db
      .prepare(`SELECT label, value, version, updated_at FROM block_history WHERE scope_key = ? AND label = ? ORDER BY version ASC`)
      .all(scopeKey(scope), label) as Array<{ label: string; value: string; version: number; updated_at: string }>;
    return rows.map((r) => ({ label: r.label, value: r.value, version: r.version, updatedAt: r.updated_at }));
  }

  private writeBlock(scopeKeyStr: string, label: string, value: string, version: number, now: string): MemoryBlock {
    this.db
      .prepare(
        `INSERT INTO blocks (scope_key, label, value, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope_key, label) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(scopeKeyStr, label, value, version, now);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO block_history (scope_key, label, version, value, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(scopeKeyStr, label, version, value, now);
    return { label, value, version, updatedAt: now };
  }

  private rowToFact(r: {
    id: string; subject: string; predicate: string; object: string; object_kind: string;
    valid_from: string; valid_until: string | null; confidence: number; source: string | null;
    expires_at: string | null; supersedes?: string | null; last_corroborated_at?: number | null;
  }): Fact {
    return {
      id: r.id,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      objectKind: r.object_kind as "entity" | "literal",
      validFrom: r.valid_from,
      ...(r.valid_until !== null ? { validUntil: r.valid_until } : {}),
      confidence: r.confidence,
      ...(r.source !== null ? { source: r.source } : {}),
      ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
      ...(r.supersedes !== null && r.supersedes !== undefined ? { supersedes: r.supersedes } : {}),
      ...(r.last_corroborated_at !== null && r.last_corroborated_at !== undefined ? { lastCorroboratedAt: r.last_corroborated_at } : {}),
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

    const tx = this.db.transaction((): { asserted: Fact; invalidated: Fact[] } => {
      const current = this.db
        .prepare(
          `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
           FROM facts WHERE scope_key = ? AND subject = ? AND predicate = ? AND valid_until IS NULL`,
        )
        .all(key, input.subject, input.predicate) as Array<{
        id: string; subject: string; predicate: string; object: string; object_kind: string;
        valid_from: string; valid_until: string | null; confidence: number; source: string | null;
        expires_at: string | null; supersedes: string | null; last_corroborated_at: number | null;
      }>;

      const same = current.find((r) => r.object === input.object);
      if (same) {
        // Idempotent: same object already currently valid.
        return { asserted: this.rowToFact(same), invalidated: [] };
      }

      // Guard: new validFrom must not precede any currently-valid prior fact's validFrom.
      for (const r of current) {
        if (validFrom < r.valid_from) {
          throw new Error(
            `temporal order violation: validFrom '${validFrom}' is earlier than the current fact's validFrom '${r.valid_from}'`,
          );
        }
      }

      const invalidated: Fact[] = [];
      const setUntil = this.db.prepare(`UPDATE facts SET valid_until = ? WHERE id = ?`);
      for (const r of current) {
        setUntil.run(validFrom, r.id);
        invalidated.push(this.rowToFact({ ...r, valid_until: validFrom }));
      }
      // State-transition link: when exactly one prior fact was superseded, record its id.
      const supersedes = invalidated.length === 1 ? invalidated[0]!.id : null;

      this.db
        .prepare(
          `INSERT INTO facts (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(id, key, input.subject, input.predicate, input.object, objectKind, validFrom, confidence, source, expiresAt, supersedes, lastCorroboratedAt);

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
    return tx();
  }

  async factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    return this.queryFacts({ scope, subject, predicate, includeInvalidated: true });
  }

  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    const ts = at ?? Date.now();
    const info = this.db
      .prepare(`UPDATE facts SET last_corroborated_at = ? WHERE scope_key = ? AND id = ? AND valid_until IS NULL`)
      .run(ts, scopeKey(scope), factId);
    return info.changes;
  }

  async expireFacts(scope: Scope, ids: string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    const key = scopeKey(scope);
    const placeholders = ids.map(() => "?").join(", ");
    const info = this.db
      .prepare(`UPDATE facts SET valid_until = ? WHERE scope_key = ? AND valid_until IS NULL AND id IN (${placeholders})`)
      .run(at, key, ...ids);
    return info.changes;
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const key = scopeKey(query.scope);
    const where: string[] = ["scope_key = @scope_key"];
    const params: Record<string, unknown> = { scope_key: key };
    if (query.subject !== undefined) { where.push("subject = @subject"); params.subject = query.subject; }
    if (query.predicate !== undefined) { where.push("predicate = @predicate"); params.predicate = query.predicate; }
    if (query.object !== undefined) { where.push("object = @object"); params.object = query.object; }
    if (query.validAt !== undefined) {
      where.push("valid_from <= @valid_at AND (valid_until IS NULL OR valid_until > @valid_at)");
      params.valid_at = query.validAt;
    } else if (!query.includeInvalidated) {
      where.push("valid_until IS NULL");
    }
    let limitClause = "";
    if (query.limit !== undefined) {
      // Bind limit as a named parameter to prevent SQL injection.
      const safeLimit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : 100;
      limitClause = " LIMIT @_limit";
      params._limit = safeLimit;
    }
    const rows = this.db
      .prepare(
        `SELECT id, subject, predicate, object, object_kind, valid_from, valid_until, confidence, source, expires_at, supersedes, last_corroborated_at
         FROM facts WHERE ${where.join(" AND ")} ORDER BY valid_from ASC${limitClause}`,
      )
      .all(params) as Array<{
      id: string; subject: string; predicate: string; object: string; object_kind: string;
      valid_from: string; valid_until: string | null; confidence: number; source: string | null;
      expires_at: string | null; supersedes: string | null; last_corroborated_at: number | null;
    }>;
    return rows.map((r) => this.rowToFact(r));
  }

  async sweepExpired(scope: Scope, now: string): Promise<number> {
    const info = this.db
      .prepare(`UPDATE facts SET valid_until = ? WHERE scope_key = ? AND valid_until IS NULL AND expires_at IS NOT NULL AND expires_at <= ?`)
      .run(now, scopeKey(scope), now);
    return info.changes;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string; apiKey?: string }): Promise<SessionRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.agentId !== undefined) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    // Fix 2: strict filter — only exact matches when a principal filter is given.
    if (opts?.userId !== undefined) {
      conditions.push("user_id = ?");
      params.push(opts.userId);
    }
    if (opts?.orgId !== undefined) {
      conditions.push("org_id = ?");
      params.push(opts.orgId);
    }
    if (opts?.apiKey !== undefined) {
      conditions.push("api_key = ?");
      params.push(opts.apiKey);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let sql = `SELECT id, agent_id, created_at, user_id, org_id, api_key FROM sessions ${where} ORDER BY created_at DESC`;
    if (opts?.limit !== undefined) {
      // Bind limit as a parameter to prevent SQL injection from non-integer inputs.
      const safeLimit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 100;
      sql += " LIMIT ?";
      params.push(safeLimit);
    }
    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<{ id: string; agent_id: string; created_at: string; user_id: string | null; org_id: string | null; api_key: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      createdAt: r.created_at,
      ...(r.user_id !== null ? { userId: r.user_id } : {}),
      ...(r.org_id !== null ? { orgId: r.org_id } : {}),
      ...(r.api_key !== null ? { apiKey: r.api_key } : {}),
    }));
  }

  async listBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const rows = this.db
      .prepare(`SELECT label, value, version, updated_at FROM blocks WHERE scope_key = ?`)
      .all(scopeKey(scope)) as Array<{ label: string; value: string; version: number; updated_at: string }>;
    return rows.map((r) => ({ label: r.label, value: r.value, version: r.version, updatedAt: r.updated_at }));
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const key = scopeKey(scope);
    const tx = this.db.transaction((): number => {
      let total = 0;
      // Scope-keyed tables
      total += this.db.prepare(`DELETE FROM facts WHERE scope_key = ?`).run(key).changes;
      total += this.db.prepare(`DELETE FROM memories WHERE scope_key = ?`).run(key).changes;
      total += this.db.prepare(`DELETE FROM memory_meta WHERE scope_key = ?`).run(key).changes;
      total += this.db.prepare(`DELETE FROM block_history WHERE scope_key = ?`).run(key).changes;
      total += this.db.prepare(`DELETE FROM blocks WHERE scope_key = ?`).run(key).changes;
      total += this.db.prepare(`DELETE FROM idempotency_keys WHERE scope_key = ?`).run(key).changes;

      const selection = sessionSelection(scope);
      if (selection) {
        const selectedSessions = `SELECT id FROM sessions WHERE ${selection.where}`;
        total += this.db.prepare(`DELETE FROM idempotency_keys WHERE session_id IN (${selectedSessions})`).run(...selection.args).changes;
        total += this.db.prepare(`DELETE FROM suspension_decisions WHERE session_id IN (${selectedSessions})`).run(...selection.args).changes;
        total += this.db.prepare(`DELETE FROM checkpoints WHERE session_id IN (${selectedSessions})`).run(...selection.args).changes;
        total += this.db.prepare(`DELETE FROM events WHERE session_id IN (${selectedSessions})`).run(...selection.args).changes;
        total += this.db.prepare(`DELETE FROM sessions WHERE ${selection.where}`).run(...selection.args).changes;
      }
      return total;
    });
    return { deleted: tx() };
  }

  async migrateLegacyScope(scope: Scope): Promise<{ migrated: number }> {
    const from = legacyScopeKey(scope);
    const to = scopeKey(scope);
    if (from === to) return { migrated: 0 };
    const tables = ["facts", "memories", "memory_meta", "block_history", "blocks", "idempotency_keys"] as const;
    const tx = this.db.transaction(() => {
      for (const table of tables) {
        const target = this.db.prepare(`SELECT 1 FROM ${table} WHERE scope_key = ? LIMIT 1`).get(to);
        if (target) throw new StoreConflictError(`legacy scope migration target is not empty: ${to}`);
      }
      let migrated = 0;
      for (const table of tables) migrated += this.db.prepare(`UPDATE ${table} SET scope_key = ? WHERE scope_key = ?`).run(to, from).changes;
      return migrated;
    });
    return { migrated: tx() };
  }

  async writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO checkpoints (session_id, seq, hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at`,
      )
      .run(sessionId, seq, hash, this.graphNow());
  }

  async lastCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const row = this.db
      .prepare(`SELECT session_id, seq, hash, created_at FROM checkpoints WHERE session_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId) as { session_id: string; seq: number; hash: string; created_at: string } | undefined;
    return row ? { sessionId: row.session_id, seq: row.seq, hash: row.hash, createdAt: row.created_at } : null;
  }

  async recordIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<void> {
    // Intent lifecycle fields are write-once; missing ownership metadata may be enriched but never reassigned.
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`INSERT OR IGNORE INTO idempotency_keys
          (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
          VALUES (?, ?, 'intent', NULL, ?, ?, ?, ?)`)
        .run(key, argsHash, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null);
      this.db
        .prepare(`UPDATE idempotency_keys SET
          scope_key = COALESCE(scope_key, ?), session_id = COALESCE(session_id, ?), owner_key = COALESCE(owner_key, ?)
          WHERE key = ?`)
        .run(metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null, key);
    });
    tx();
  }

  async claimIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean> {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO idempotency_keys
        (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
        VALUES (?, ?, 'intent', NULL, ?, ?, ?, ?)`)
      .run(key, argsHash, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null);
    return result.changes === 1;
  }

  async releaseIntent(key: string, argsHash: string): Promise<boolean> {
    const result = this.db.prepare(
      `DELETE FROM idempotency_keys WHERE key = ? AND args_hash = ? AND status = 'intent'`,
    ).run(key, argsHash);
    return result.changes === 1;
  }

  async recordCompletion(key: string, result: unknown, metadata?: IdempotencyMetadata): Promise<void> {
    const serialized = JSON.stringify(result ?? null);
    const tx = this.db.transaction(() => {
      // Ensure a row exists (covers completion without a prior intent), then flip to applied.
      this.db
        .prepare(`INSERT OR IGNORE INTO idempotency_keys
          (key, args_hash, status, result, created_at, scope_key, session_id, owner_key)
          VALUES (?, '', 'intent', NULL, ?, ?, ?, ?)`)
        .run(key, this.graphNow(), metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null);
      this.db
        .prepare(`UPDATE idempotency_keys SET status = 'applied', result = ?,
          scope_key = COALESCE(scope_key, ?), session_id = COALESCE(session_id, ?), owner_key = COALESCE(owner_key, ?)
          WHERE key = ?`)
        .run(serialized, metadata?.scopeKey ?? null, metadata?.sessionId ?? null, metadata?.ownerKey ?? null, key);
    });
    tx();
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const row = this.db
      .prepare(`SELECT key, args_hash, status, result, created_at, scope_key, session_id, owner_key FROM idempotency_keys WHERE key = ?`)
      .get(key) as { key: string; args_hash: string; status: string; result: string | null; created_at: string; scope_key: string | null; session_id: string | null; owner_key: string | null } | undefined;
    if (!row) return null;
    return {
      key: row.key,
      argsHash: row.args_hash,
      status: row.status as IdempotencyStatus,
      ...(row.result !== null ? { result: JSON.parse(row.result) } : {}),
      createdAt: row.created_at,
      ...(row.scope_key !== null ? { scopeKey: row.scope_key } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.owner_key !== null ? { ownerKey: row.owner_key } : {}),
    };
  }

  async recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void> {
    const serialized = JSON.stringify(decision);
    // Write-once per (session, call); a re-record overwrites in v1 (tests never re-record same key).
    this.db
      .prepare(
        `INSERT INTO suspension_decisions (session_id, call_id, decision, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, call_id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
      )
      .run(sessionId, callId, serialized, this.graphNow());
  }

  async getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null> {
    const row = this.db
      .prepare(`SELECT decision FROM suspension_decisions WHERE session_id = ? AND call_id = ?`)
      .get(sessionId, callId) as { decision: string } | undefined;
    return row ? (JSON.parse(row.decision) as SuspendDecision) : null;
  }
}
