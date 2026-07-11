/**
 * @eidentic/convex — Convex-backed Eidentic stores and runners.
 *
 * Preferred architecture: install the Convex Component from
 * `@eidentic/convex/convex.config.js`, then use `EidenticComponentStore` from a host action
 * through `ctx.runQuery` / `ctx.runMutation`.
 *
 * Compatibility architecture: the app-functions model still lets an agent runtime outside Convex
 * talk to a deployment via an injectable `runner`. In production the runner wraps a
 * `ConvexHttpClient`; in tests it wraps a `convex-test` instance.
 *
 * IDs cross the client boundary as strings (see server.ts), so the client passes plain string
 * scope keys / ids and never touches Convex document `_id`s.
 */
import {
  StoreConflictError,
  legacyScopeKey,
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
  type IdempotencyMetadata,
  type SuspendDecision,
} from "@eidentic/types";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";

// Re-export the authorization hook + secure factory so apps can import them from "@eidentic/convex".
// (The handler functions themselves live at "@eidentic/convex/server" and are re-exported from the
// host app's own `convex/` module, NOT from here.)
export { eidenticFunctions, type EidenticAuthorize, type EidenticFunctionsOptions } from "./server.js";

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
  replaceSessionApiKey: FnRef;
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
  listMemory: FnRef;
  deleteMemory: FnRef;
  assertFact: FnRef;
  queryFacts: FnRef;
  corroborate: FnRef;
  expireFacts: FnRef;
  sweepExpired: FnRef;
  eraseScope: FnRef;
  migrateLegacyScope: FnRef;
  writeCheckpoint: FnRef;
  lastCheckpoint: FnRef;
  recordIntent: FnRef;
  claimIntent: FnRef;
  releaseIntent: FnRef;
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
  "createSession", "getSession", "replaceSessionApiKey", "listSessions", "appendEvents", "readEvents",
  "getBlocks", "getBlock", "upsertBlock", "appendBlock", "getBlockHistory", "listBlocks",
  "indexMemory", "searchMemory", "listMemory", "deleteMemory", "assertFact", "queryFacts", "corroborate", "expireFacts",
  "sweepExpired", "eraseScope", "migrateLegacyScope",
  "writeCheckpoint", "lastCheckpoint", "recordIntent", "claimIntent", "releaseIntent", "recordCompletion", "getIdempotency",
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

function resolveFunctionNamespace(source: unknown): Record<string, FnRef> {
  const root = source as Record<string, unknown>;
  const nested = root["functions"];
  if (nested && typeof nested === "object") return nested as Record<string, FnRef>;
  return root as Record<string, FnRef>;
}

function pickFns<T>(source: unknown, names: readonly string[], label: string): T {
  const ns = resolveFunctionNamespace(source);
  const out: Record<string, FnRef> = {};
  for (const name of names) {
    const ref = ns[name];
    if (ref === undefined) {
      throw new Error(`missing Eidentic ${label} function reference '${name}'`);
    }
    out[name] = ref;
  }
  return out as T;
}

/**
 * Extract store function refs from either a generated component API
 * (`components.eidentic` / `components.eidentic.functions`) or an app-functions API module
 * (`api.eidentic`).
 */
export function storeFnsFrom(source: unknown): ConvexStoreFns {
  return pickFns<ConvexStoreFns>(source, STORE_FN_NAMES, "store");
}

/** Extract vector function refs from a generated component or app-functions API module. */
export function vectorFnsFrom(source: unknown): ConvexVectorFns {
  return pickFns<ConvexVectorFns>(source, VECTOR_FN_NAMES, "vector");
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

/** Minimal normalized view of Convex runner methods. Useful for tests and custom bridges. */
export interface ConvexActionCtxLike {
  runQuery(fn: unknown, args: Record<string, unknown>): Promise<unknown>;
  runMutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>;
  runAction?: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
}

type QueryFunctionReference = FunctionReference<"query", "public" | "internal">;
type MutationFunctionReference = FunctionReference<"mutation", "public" | "internal">;
type ActionFunctionReference = FunctionReference<"action", "public" | "internal">;

/**
 * Structural view of Convex's generated action/mutation contexts.
 *
 * Convex types `ctx.runQuery`, `ctx.runMutation`, and `ctx.runAction` with generic
 * `FunctionReference` parameters. The SDK normalizes that stricter signature internally so host
 * apps can pass their generated `ActionCtx` or `MutationCtx` directly without writing an
 * `unknown` bridge.
 */
export interface ConvexFunctionRefCtxLike {
  runQuery<Query extends QueryFunctionReference>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>>;
  runMutation<Mutation extends MutationFunctionReference>(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>>;
  runAction?<Action extends ActionFunctionReference>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>>;
}

/** Accepted Convex action context shapes for in-process component calls. */
export type ConvexActionCtxInput = ConvexActionCtxLike | ConvexFunctionRefCtxLike;

function normalizeActionCtx(ctx: ConvexActionCtxInput): ConvexActionCtxLike {
  const runQuery = ctx.runQuery as unknown as ConvexActionCtxLike["runQuery"];
  const runMutation = ctx.runMutation as unknown as ConvexActionCtxLike["runMutation"];
  const runAction =
    "runAction" in ctx && ctx.runAction
      ? (ctx.runAction as unknown as NonNullable<ConvexActionCtxLike["runAction"]>)
      : undefined;

  return {
    runQuery: (fn, args) => runQuery.call(ctx, fn, args),
    runMutation: (fn, args) => runMutation.call(ctx, fn, args),
    ...(runAction ? { runAction: (fn, args) => runAction.call(ctx, fn, args) } : {}),
  };
}

/**
 * Build an in-process runner for Convex actions. This is the natural runner for the component path:
 * host actions authenticate and assemble business context, then call Eidentic component functions
 * through `ctx.runQuery` / `ctx.runMutation`.
 */
export function convexActionRunner(ctx: ConvexActionCtxInput): ConvexRunner {
  const actionCtx = normalizeActionCtx(ctx);
  return {
    query: (fn, args) => actionCtx.runQuery(fn, args),
    mutation: (fn, args) => actionCtx.runMutation(fn, args),
    action: (fn, args) => {
      if (!actionCtx.runAction) throw new Error("ctx.runAction is not available on this Convex context");
      return actionCtx.runAction(fn, args);
    },
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

function idempotencyMetadataArgs(metadata?: IdempotencyMetadata): Record<string, unknown> {
  if (!metadata) return {};
  return {
    ...(metadata.scopeKey !== undefined ? { scopeKey: metadata.scopeKey } : {}),
    ...(metadata.sessionId !== undefined ? { sessionId: metadata.sessionId } : {}),
    ...(metadata.ownerKey !== undefined ? { ownerKey: metadata.ownerKey } : {}),
  };
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

  async replaceSessionApiKey(sessionId: string, expected: string, replacement: string): Promise<boolean> {
    return (await this.runner.mutation(this.fns.replaceSessionApiKey, { sessionId, expected, replacement })) as boolean;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string; apiKey?: string }): Promise<SessionRecord[]> {
    const args: Record<string, unknown> = {};
    if (opts?.agentId !== undefined) args["agentId"] = opts.agentId;
    if (opts?.limit !== undefined) args["limit"] = opts.limit;
    if (opts?.userId !== undefined) args["userId"] = opts.userId;
    if (opts?.orgId !== undefined) args["orgId"] = opts.orgId;
    if (opts?.apiKey !== undefined) args["apiKey"] = opts.apiKey;
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

  async listMemory(scope: Scope) {
    return (await this.runner.query(this.fns.listMemory, { scopeKey: scopeKey(scope) })) as Array<{
      id: string;
      text: string;
      ingestedAt?: number;
      metadata?: Record<string, unknown>;
    }>;
  }

  async deleteMemory(scope: Scope, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return (await this.runner.mutation(this.fns.deleteMemory, {
      scopeKey: scopeKey(scope),
      ids: [...new Set(ids)],
    })) as number;
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const args: Record<string, unknown> = { scopeKey: scopeKey(scope) };
    // Preserve the old wire shape for agent/shared scopes so a newer client remains compatible
    // with already-deployed Convex functions. Narrower scopes require the new discriminator and
    // therefore fail closed against an old backend instead of falling back to agent-wide erasure.
    if (scope.kind === "agent") {
      args["agentId"] = scope.agentId;
    } else if (scope.kind === "user") {
      args["kind"] = scope.kind;
      args["agentId"] = scope.agentId;
      args["userId"] = scope.userId;
    } else if (scope.kind === "org") {
      args["kind"] = scope.kind;
      args["agentId"] = scope.agentId;
      args["orgId"] = scope.orgId;
    } else if (scope.kind === "thread") {
      args["kind"] = scope.kind;
      args["agentId"] = scope.agentId;
      args["sessionId"] = scope.sessionId;
    }
    return (await this.runner.mutation(this.fns.eraseScope, args)) as { deleted: number };
  }

  async migrateLegacyScope(scope: Scope): Promise<{ migrated: number }> {
    const fromScopeKey = legacyScopeKey(scope);
    const toScopeKey = scopeKey(scope);
    if (fromScopeKey === toScopeKey) return { migrated: 0 };
    return (await this.runner.mutation(this.fns.migrateLegacyScope, { fromScopeKey, toScopeKey })) as { migrated: number };
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

  async recordIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<void> {
    await this.runner.mutation(this.fns.recordIntent, {
      key,
      argsHash,
      now: this.now(),
      ...idempotencyMetadataArgs(metadata),
    });
  }

  async claimIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean> {
    return (await this.runner.mutation(this.fns.claimIntent, {
      key,
      argsHash,
      now: this.now(),
      ...idempotencyMetadataArgs(metadata),
    })) as boolean;
  }

  async releaseIntent(key: string, argsHash: string, metadata?: IdempotencyMetadata): Promise<boolean> {
    return (await this.runner.mutation(this.fns.releaseIntent, {
      key,
      argsHash,
      ...idempotencyMetadataArgs(metadata),
    })) as boolean;
  }

  async recordCompletion(key: string, result: unknown, metadata?: IdempotencyMetadata): Promise<void> {
    // Serialize so the result's object-key order survives the Convex `v.any()` round-trip.
    await this.runner.mutation(this.fns.recordCompletion, {
      key,
      result: JSON.stringify(result ?? null),
      now: this.now(),
      ...idempotencyMetadataArgs(metadata),
    });
  }

  async getIdempotency(key: string, metadata?: IdempotencyMetadata): Promise<IdempotencyRecord | null> {
    const row = (await this.runner.query(this.fns.getIdempotency, {
      key,
      ...idempotencyMetadataArgs(metadata),
    })) as
      | {
          key: string;
          argsHash: string;
          status: "intent" | "applied";
          result?: string;
          createdAt: string;
          scopeKey?: string;
          sessionId?: string;
          ownerKey?: string;
        }
      | null;
    if (!row) return null;
    // `result` is a JSON string on the wire (preserves object-key order) — parse it here.
    return {
      key: row.key,
      argsHash: row.argsHash,
      status: row.status,
      ...(row.result !== undefined ? { result: JSON.parse(row.result) } : {}),
      createdAt: row.createdAt,
      ...(row.scopeKey !== undefined ? { scopeKey: row.scopeKey } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      ...(row.ownerKey !== undefined ? { ownerKey: row.ownerKey } : {}),
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

export interface EidenticComponentStoreOptions extends Omit<ConvexStoreOptions, "fns"> {
  /** Optional explicit refs; by default refs are extracted from the generated component API. */
  fns?: ConvexStoreFns;
}

export class EidenticComponentStore extends ConvexStore {
  constructor(ctx: ConvexActionCtxInput, component: unknown, opts: EidenticComponentStoreOptions = {}) {
    const { fns, ...storeOpts } = opts;
    super(convexActionRunner(ctx), { ...storeOpts, fns: fns ?? storeFnsFrom(component) });
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

export interface EidenticComponentVectorStoreOptions extends Omit<ConvexVectorStoreOptions, "fns"> {
  /** Optional explicit refs; by default refs are extracted from the generated component API. */
  fns?: ConvexVectorFns;
}

export class EidenticComponentVectorStore extends ConvexVectorStore {
  constructor(ctx: ConvexActionCtxInput, component: unknown, opts: EidenticComponentVectorStoreOptions = {}) {
    const { fns } = opts;
    super(convexActionRunner(ctx), { fns: fns ?? vectorFnsFrom(component) });
  }
}

export interface EidenticFromActionCtxOptions {
  /** Options for the durable store. */
  store?: EidenticComponentStoreOptions;
  /** Options for the vector store. */
  vectors?: EidenticComponentVectorStoreOptions;
}

export interface EidenticFromActionCtxResult {
  store: EidenticComponentStore;
  vectors: EidenticComponentVectorStore;
}

/**
 * Build Eidentic component stores directly from a Convex action context.
 *
 * This is the ergonomic component entry point for host apps using generated Convex `ActionCtx`
 * types. It keeps the unavoidable opaque function-reference normalization inside the SDK.
 */
export function fromActionCtx(
  ctx: ConvexActionCtxInput,
  component: unknown,
  opts: EidenticFromActionCtxOptions = {},
): EidenticFromActionCtxResult {
  return {
    store: new EidenticComponentStore(ctx, component, opts.store),
    vectors: new EidenticComponentVectorStore(ctx, component, opts.vectors),
  };
}
