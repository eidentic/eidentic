/**
 * @eidentic/convex — a Convex-backed `StorePort & GraphPort` (`ConvexStore`) and `VectorPort`
 * (`ConvexVectorStore`).
 *
 * Architecture (app-functions model, NOT a Convex Component): the agent runtime runs OUTSIDE
 * Convex and talks to a deployment via an injectable `runner`. In production the runner wraps a
 * `ConvexHttpClient`; in tests it wraps a `convex-test` instance. The Convex function handlers
 * live in `@eidentic/convex/server` and are re-exported by the host app from a file in its
 * `convex/` directory; the schema tables live in `@eidentic/convex/schema`.
 *
 * IDs cross the client boundary as strings (see server.ts), so the client passes plain string
 * scope keys / ids and never touches Convex document `_id`s.
 */
import {
  StoreConflictError,
  scopeKey,
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
  type VectorPort,
  type VectorEntry,
  type VectorSearchResult,
  type DurablePort,
  type Checkpoint,
  type IdempotencyRecord,
  type SuspendDecision,
} from "@eidentic/types";

// Re-export the authorization hook + secure factory so apps can import them from "@eidentic/convex".
// (The handler functions themselves live at "@eidentic/convex/server" and are re-exported from the
// host app's own `convex/` module, NOT from here.)
export { eidenticFunctions, type EidenticAuthorize } from "./server.js";

// ---------------------------------------------------------------------------
// Runner + function references
// ---------------------------------------------------------------------------

/**
 * A function reference. In production this is a Convex `FunctionReference` (e.g.
 * `api.eidentic.appendEvents`, or an `anyApi` string-path ref like `anyApi.eidentic.appendEvents`);
 * in tests it is the same kind of object resolved through `convex-test`. The adapter treats it as
 * an opaque handle and forwards it to the runner.
 */
export type FnRef = unknown;

/**
 * The injectable transport. Implementations forward `(fnRef, args)` to a Convex deployment.
 * - `convexHttpRunner(client)` wraps a `ConvexHttpClient` for production.
 * - In tests, wrap a `convex-test` instance: `{ query: t.query, mutation: t.mutation, action: t.action }`.
 */
export interface ConvexRunner {
  query(fn: FnRef, args: Record<string, unknown>): Promise<unknown>;
  mutation(fn: FnRef, args: Record<string, unknown>): Promise<unknown>;
  action(fn: FnRef, args: Record<string, unknown>): Promise<unknown>;
}

/** The set of store/graph function references the runtime calls. Defaults to `anyApi` string paths. */
export interface ConvexStoreFns {
  createSession: FnRef;
  getSession: FnRef;
  listSessions: FnRef;
  appendEvents: FnRef;
  readEvents: FnRef;
  getBlocks: FnRef;
  getBlock: FnRef;
  upsertBlock: FnRef;
  appendBlock: FnRef;
  getBlockHistory: FnRef;
  listBlocks: FnRef;
  indexMemory: FnRef;
  searchMemory: FnRef;
  assertFact: FnRef;
  queryFacts: FnRef;
  corroborate: FnRef;
  expireFacts: FnRef;
  sweepExpired: FnRef;
  eraseScope: FnRef;
  writeCheckpoint: FnRef;
  lastCheckpoint: FnRef;
  recordIntent: FnRef;
  recordCompletion: FnRef;
  getIdempotency: FnRef;
  recordDecision: FnRef;
  getDecision: FnRef;
}

/** The set of vector function references the runtime calls. */
export interface ConvexVectorFns {
  vectorUpsert: FnRef;
  vectorSearch: FnRef;
  vectorDelete: FnRef;
  vectorEraseScope: FnRef;
  vectorList: FnRef;
}

const STORE_FN_NAMES: (keyof ConvexStoreFns)[] = [
  "createSession", "getSession", "listSessions", "appendEvents", "readEvents",
  "getBlocks", "getBlock", "upsertBlock", "appendBlock", "getBlockHistory", "listBlocks",
  "indexMemory", "searchMemory", "assertFact", "queryFacts", "corroborate", "expireFacts",
  "sweepExpired", "eraseScope",
  "writeCheckpoint", "lastCheckpoint", "recordIntent", "recordCompletion", "getIdempotency",
  "recordDecision", "getDecision",
];

const VECTOR_FN_NAMES: (keyof ConvexVectorFns)[] = [
  "vectorUpsert", "vectorSearch", "vectorDelete", "vectorEraseScope", "vectorList",
];

/**
 * Build the default store function refs by string path (e.g. "eidentic:appendEvents") for a runner
 * that accepts string-path refs (`ConvexHttpClient` + `anyApi`, or a test runner that maps paths).
 * `prefix` is the convex module name the host re-exported the functions from (default "eidentic").
 */
export function defaultStoreFns(prefix = "eidentic"): ConvexStoreFns {
  return Object.fromEntries(STORE_FN_NAMES.map((n) => [n, `${prefix}:${n}`])) as unknown as ConvexStoreFns;
}

/** Build the default vector function refs by string path. See {@link defaultStoreFns}. */
export function defaultVectorFns(prefix = "eidentic"): ConvexVectorFns {
  return Object.fromEntries(VECTOR_FN_NAMES.map((n) => [n, `${prefix}:${n}`])) as unknown as ConvexVectorFns;
}

/** Minimal structural view of `ConvexHttpClient` (from `convex/browser`). */
export interface ConvexHttpClientLike {
  query(fn: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>;
  action(fn: unknown, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Build a production `ConvexRunner` from a `ConvexHttpClient` (`convex/browser`). Pass `anyApi`
 * string-path refs or codegen `api.*` refs as the function references. Example:
 *
 *   import { ConvexHttpClient } from "convex/browser";
 *   import { anyApi } from "convex/server";
 *   import { ConvexStore, convexHttpRunner } from "@eidentic/convex";
 *
 *   const client = new ConvexHttpClient(process.env.CONVEX_URL!);
 *   const store = new ConvexStore(convexHttpRunner(client));
 *   //                                              ^ defaults to anyApi "eidentic:*" string paths
 */
export function convexHttpRunner(client: ConvexHttpClientLike): ConvexRunner {
  return {
    query: (fn, args) => client.query(fn, args),
    mutation: (fn, args) => client.mutation(fn, args),
    action: (fn, args) => client.action(fn, args),
  };
}

/**
 * Rethrow a server-side conflict (thrown with the "conflict:" marker prefix in server.ts) as a
 * `StoreConflictError`. Convex serializes thrown errors into the message, so we match on the
 * marker (and the libsql-compatible /conflict/i pattern) regardless of transport wrapping.
 */
function rethrowConflict(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/conflict|UNIQUE constraint|constraint/i.test(msg)) {
    throw new StoreConflictError(`conflict: ${msg}`);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// ConvexStore — StorePort & GraphPort
// ---------------------------------------------------------------------------

export interface ConvexStoreOptions {
  /** Override store function references (defaults to `defaultStoreFns()` — "eidentic:*" paths). */
  fns?: ConvexStoreFns;
  /** Override fact ID generation (useful in tests for determinism). */
  newId?: () => string;
  /** Override "now" timestamp (useful in tests). */
  now?: () => string;
}

export class ConvexStore implements StorePort, GraphPort, DurablePort {
  private readonly fns: ConvexStoreFns;
  private factIdCounter = 0;
  private readonly newFactId: () => string;
  private readonly now: () => string;

  constructor(private readonly runner: ConvexRunner, opts: ConvexStoreOptions = {}) {
    this.fns = opts.fns ?? defaultStoreFns();
    this.newFactId =
      opts.newId ?? (() => `fact_${Date.now().toString(36)}_${(this.factIdCounter++).toString(36)}`);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // Convex manages the schema; there is no connection to open or close.
  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  // --- Sessions ---

  async createSession(s: SessionRecord): Promise<void> {
    await this.runner.mutation(this.fns.createSession, { session: s });
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return (await this.runner.query(this.fns.getSession, { id })) as SessionRecord | null;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string }): Promise<SessionRecord[]> {
    const args: Record<string, unknown> = {};
    if (opts?.agentId !== undefined) args["agentId"] = opts.agentId;
    if (opts?.limit !== undefined) args["limit"] = opts.limit;
    if (opts?.userId !== undefined) args["userId"] = opts.userId;
    if (opts?.orgId !== undefined) args["orgId"] = opts.orgId;
    return (await this.runner.query(this.fns.listSessions, args)) as SessionRecord[];
  }

  // --- Events ---

  async appendEvents(events: StoredEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.runner.mutation(this.fns.appendEvents, { events });
    } catch (err) {
      rethrowConflict(err);
    }
  }

  async readEvents(sessionId: string): Promise<StoredEvent[]> {
    return (await this.runner.query(this.fns.readEvents, { sessionId })) as StoredEvent[];
  }

  // --- Blocks ---

  async getBlocks(scope: Scope): Promise<MemoryBlock[]> {
    return (await this.runner.query(this.fns.getBlocks, { scopeKey: scopeKey(scope) })) as MemoryBlock[];
  }

  async getBlock(scope: Scope, label: string): Promise<MemoryBlock | null> {
    return (await this.runner.query(this.fns.getBlock, { scopeKey: scopeKey(scope), label })) as MemoryBlock | null;
  }

  async upsertBlock(scope: Scope, block: { label: string; value: string }, expectVersion?: number): Promise<MemoryBlock> {
    const args: Record<string, unknown> = {
      scopeKey: scopeKey(scope),
      label: block.label,
      value: block.value,
      now: this.now(),
    };
    if (expectVersion !== undefined) args["expectVersion"] = expectVersion;
    try {
      return (await this.runner.mutation(this.fns.upsertBlock, args)) as MemoryBlock;
    } catch (err) {
      rethrowConflict(err);
    }
  }

  async appendBlock(scope: Scope, label: string, text: string): Promise<MemoryBlock> {
    return (await this.runner.mutation(this.fns.appendBlock, {
      scopeKey: scopeKey(scope),
      label,
      text,
      now: this.now(),
    })) as MemoryBlock;
  }

  async getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]> {
    return (await this.runner.query(this.fns.getBlockHistory, { scopeKey: scopeKey(scope), label })) as BlockHistoryEntry[];
  }

  async listBlocks(scope: Scope): Promise<MemoryBlock[]> {
    return (await this.runner.query(this.fns.listBlocks, { scopeKey: scopeKey(scope) })) as MemoryBlock[];
  }

  // --- Memory (lexical) ---

  async indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>): Promise<void> {
    if (entries.length === 0) return;
    const mapped = entries.map((e) => ({
      scopeKey: scopeKey(e.scope),
      id: e.id,
      text: e.text,
      ...(e.ingestedAt !== undefined ? { ingestedAt: e.ingestedAt } : {}),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    await this.runner.mutation(this.fns.indexMemory, { entries: mapped });
  }

  async searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]> {
    return (await this.runner.query(this.fns.searchMemory, { scopeKey: scopeKey(scope), query, topK })) as MemorySnippet[];
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const args: Record<string, unknown> = { scopeKey: scopeKey(scope) };
    if ("agentId" in scope) args["agentId"] = (scope as { agentId: string }).agentId;
    return (await this.runner.mutation(this.fns.eraseScope, args)) as { deleted: number };
  }

  // --- Graph (Facts) ---

  async assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    const args: Record<string, unknown> = {
      scopeKey: scopeKey(scope),
      factId: this.newFactId(),
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      validFrom: input.validFrom ?? this.now(),
    };
    if (input.objectKind !== undefined) args["objectKind"] = input.objectKind;
    if (input.confidence !== undefined) args["confidence"] = input.confidence;
    if (input.source !== undefined) args["source"] = input.source;
    if (input.ttlMs !== undefined) args["ttlMs"] = input.ttlMs;
    if (input.expiresAt !== undefined) args["expiresAt"] = input.expiresAt;
    if (input.lastCorroboratedAt !== undefined) args["lastCorroboratedAt"] = input.lastCorroboratedAt;
    return (await this.runner.mutation(this.fns.assertFact, args)) as { asserted: Fact; invalidated: Fact[] };
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const args: Record<string, unknown> = { scopeKey: scopeKey(query.scope) };
    if (query.subject !== undefined) args["subject"] = query.subject;
    if (query.predicate !== undefined) args["predicate"] = query.predicate;
    if (query.object !== undefined) args["object"] = query.object;
    if (query.validAt !== undefined) args["validAt"] = query.validAt;
    if (query.includeInvalidated !== undefined) args["includeInvalidated"] = query.includeInvalidated;
    if (query.limit !== undefined) args["limit"] = query.limit;
    return (await this.runner.query(this.fns.queryFacts, args)) as Fact[];
  }

  async factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    return this.queryFacts({ scope, subject, predicate, includeInvalidated: true });
  }

  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    return (await this.runner.mutation(this.fns.corroborate, {
      scopeKey: scopeKey(scope),
      factId,
      at: at ?? Date.now(),
    })) as number;
  }

  async expireFacts(scope: Scope, ids: string[], at: string): Promise<number> {
    if (ids.length === 0) return 0;
    return (await this.runner.mutation(this.fns.expireFacts, { scopeKey: scopeKey(scope), ids, at })) as number;
  }

  async sweepExpired(scope: Scope, now: string): Promise<number> {
    return (await this.runner.mutation(this.fns.sweepExpired, { scopeKey: scopeKey(scope), now })) as number;
  }

  // --- Durable (checkpoints + idempotency ledger + suspension decisions) ---

  async writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void> {
    await this.runner.mutation(this.fns.writeCheckpoint, { sessionId, seq, hash, now: this.now() });
  }

  async lastCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    return (await this.runner.query(this.fns.lastCheckpoint, { sessionId })) as Checkpoint | null;
  }

  async recordIntent(key: string, argsHash: string): Promise<void> {
    await this.runner.mutation(this.fns.recordIntent, { key, argsHash, now: this.now() });
  }

  async recordCompletion(key: string, result: unknown): Promise<void> {
    // Serialize so the result's object-key order survives the Convex `v.any()` round-trip.
    await this.runner.mutation(this.fns.recordCompletion, {
      key,
      result: JSON.stringify(result ?? null),
      now: this.now(),
    });
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const row = (await this.runner.query(this.fns.getIdempotency, { key })) as
      | { key: string; argsHash: string; status: "intent" | "applied"; result?: string; createdAt: string }
      | null;
    if (!row) return null;
    // `result` is a JSON string on the wire (preserves object-key order) — parse it here.
    return {
      key: row.key,
      argsHash: row.argsHash,
      status: row.status,
      ...(row.result !== undefined ? { result: JSON.parse(row.result) } : {}),
      createdAt: row.createdAt,
    };
  }

  async recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void> {
    await this.runner.mutation(this.fns.recordDecision, {
      sessionId,
      callId,
      decision: JSON.stringify(decision),
      now: this.now(),
    });
  }

  async getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null> {
    const raw = (await this.runner.query(this.fns.getDecision, { sessionId, callId })) as string | null;
    return raw === null ? null : (JSON.parse(raw) as SuspendDecision);
  }
}

// ---------------------------------------------------------------------------
// ConvexVectorStore — VectorPort
// ---------------------------------------------------------------------------

export interface ConvexVectorStoreOptions {
  /** Override vector function references (defaults to `defaultVectorFns()` — "eidentic:*" paths). */
  fns?: ConvexVectorFns;
}

export class ConvexVectorStore implements VectorPort {
  private readonly fns: ConvexVectorFns;

  constructor(private readonly runner: ConvexRunner, opts: ConvexVectorStoreOptions = {}) {
    this.fns = opts.fns ?? defaultVectorFns();
  }

  async upsert(entry: VectorEntry): Promise<void> {
    await this.runner.mutation(this.fns.vectorUpsert, {
      id: entry.id,
      scopeKey: entry.scopeKey,
      text: entry.text,
      vector: entry.vector,
    });
  }

  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    return (await this.runner.query(this.fns.vectorSearch, { queryVector, scopeKey, topK })) as VectorSearchResult[];
  }

  async delete(id: string, scopeKey: string): Promise<void> {
    await this.runner.mutation(this.fns.vectorDelete, { id, scopeKey });
  }

  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    return (await this.runner.mutation(this.fns.vectorEraseScope, { scopeKey })) as { deleted: number };
  }

  async list(scopeKey: string): Promise<VectorEntry[]> {
    return (await this.runner.query(this.fns.vectorList, { scopeKey })) as VectorEntry[];
  }
}
