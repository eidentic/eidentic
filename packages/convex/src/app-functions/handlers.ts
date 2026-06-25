/**
 * Eidentic Convex function handlers (the server side of the adapter).
 *
 * These are the `query` / `mutation` functions the host app re-exports from a file in its
 * `convex/` directory, e.g.:
 *
 *   // convex/eidentic.ts
 *   export * from "@eidentic/convex/server";
 *
 * They are built with the GENERIC builders (`queryGeneric` / `mutationGeneric`) typed over the
 * eidentic schema, so the package does NOT depend on the host app's `_generated` codegen. The
 * `ConvexStore` / `ConvexVectorStore` clients (see `index.ts`) call them through an injectable
 * runner — `ConvexHttpClient` in production, a `convex-test` instance in tests.
 *
 * IDs cross the client boundary as strings; every arg/return validator uses `v.string()` etc.
 *
 * Atomicity: a single Convex mutation runs in one transaction, so multi-row writes (appendEvents,
 * upsertBlock + history, indexMemory delete-then-insert, assertFact invalidate + insert, eraseScope)
 * commit or roll back together. Conflict detection in appendEvents runs BEFORE any insert so the
 * whole batch rolls back atomically on a duplicate.
 *
 * Search: lexical (`searchMemory`) and vector (`vectorSearch`) ranking is computed by reading the
 * scope's rows via the scope index and scoring in JS (TF for lexical, cosine for vector). This is
 * deterministic and testable under convex-test, which mocks Convex's native search/vector indexes.
 * Native `searchIndex` / `vectorIndex` are a future performance optimization — see README.
 */
import {
  queryGeneric,
  mutationGeneric,
  type GenericQueryCtx,
  type GenericMutationCtx,
  type RegisteredQuery,
  type RegisteredMutation,
} from "convex/server";
import { v } from "convex/values";
import { tokenize } from "@eidentic/types";
import type { EidenticTableNames } from "../schema.js";

// ---------------------------------------------------------------------------
// Shared validators / helpers
// ---------------------------------------------------------------------------

// The handlers are table-name-parameterized so app-functions can keep legacy table names while
// the component can use singular snake_case names inside its isolated schema. The generic Convex
// ctx keeps this package independent from host-app and component codegen.
type QCtx = Omit<GenericQueryCtx<any>, "db"> & { db: any };
type MCtx = Omit<GenericMutationCtx<any>, "db"> & { db: any };

// ---------------------------------------------------------------------------
// Authorization hook
// ---------------------------------------------------------------------------

/**
 * An authorization hook run BEFORE every eidentic function handler.
 *
 * It receives the Convex function `ctx` (so it can read `ctx.auth.getUserIdentity()`,
 * `ctx.db`, etc.) and `info` describing the operation: its name (`op`, e.g. `"getBlocks"`)
 * and the validated `args` (e.g. `{ scopeKey }`). It DENIES by throwing — a thrown error
 * rejects the op before the handler body runs. Returning (or resolving) ALLOWS the op.
 *
 * Use it to enforce authentication and `scopeKey` ownership, e.g.:
 *
 *   const authorize: EidenticAuthorize = async (ctx, { args }) => {
 *     const identity = await ctx.auth.getUserIdentity();
 *     if (!identity) throw new Error("unauthenticated");
 *     // optionally: assert the caller owns `args.scopeKey`
 *   };
 */
export type EidenticAuthorize = (
  ctx: QCtx | MCtx,
  info: { op: string; args: Record<string, unknown> },
) => void | Promise<void>;

const sessionValidator = v.object({
  id: v.string(),
  agentId: v.string(),
  createdAt: v.string(),
  userId: v.optional(v.string()),
  orgId: v.optional(v.string()),
  apiKey: v.optional(v.string()),
});

const eventValidator = v.object({
  id: v.string(),
  sessionId: v.string(),
  seq: v.number(),
  kind: v.string(),
  schemaVersion: v.number(),
  payload: v.any(),
  meta: v.optional(v.any()),
  createdAt: v.string(),
});

/** Marker prefix on thrown errors so the client can rethrow them as StoreConflictError. */
const CONFLICT_PREFIX = "conflict:";

/** Strip a Convex doc to the public shape the client expects (drops `_id` / `_creationTime`). */
function stripBlock(doc: { label: string; value: string; version: number; updatedAt: string }) {
  return { label: doc.label, value: doc.value, version: doc.version, updatedAt: doc.updatedAt };
}

// ---------------------------------------------------------------------------
// Single source of truth: handler registry
//
// Each handler's `{ kind, args, returns?, handler }` spec is recorded ONCE in `HANDLERS` via
// `defineQuery` / `defineMutation`, which ALSO build and return the live Convex function. The 31
// top-level `const X = …` below therefore stay byte-for-byte equivalent to the old direct
// `mutationGeneric(...)` / `queryGeneric(...)` calls (back-compat: `export * from
// "@eidentic/convex/server"` keeps working, unauthenticated). The `eidenticFunctions({ authorize })`
// factory (bottom of file) replays the same registry, wrapping each handler so `authorize` runs
// first — so both paths build from one definition and can never drift.
// ---------------------------------------------------------------------------

/** A handler's raw arg type is whatever Convex infers from its `args` validator; we keep it loose. */
type AnyHandler = (ctx: never, args: never) => unknown;

interface QuerySpec {
  kind: "query";
  args: Record<string, unknown>;
  returns?: unknown;
  handler: AnyHandler;
}
interface MutationSpec {
  kind: "mutation";
  args: Record<string, unknown>;
  returns?: unknown;
  handler: AnyHandler;
}
type HandlerSpec = QuerySpec | MutationSpec;

type EidenticRegisteredFunction = RegisteredMutation<"public", any, any> | RegisteredQuery<"public", any, any>;

export interface EidenticHandlerSet {
  functions: Record<string, EidenticRegisteredFunction>;
  handlers: Record<string, HandlerSpec>;
}

export function defineEidenticHandlers(tables: EidenticTableNames): EidenticHandlerSet {
  /** Insertion-ordered registry of every handler, keyed by its exported function name. */
  const HANDLERS: Record<string, HandlerSpec> = {};

// The return types are the PUBLIC, nameable `RegisteredQuery` / `RegisteredMutation` aliases from
// `convex/server` (args/returns loosened to `any`). Annotating explicitly avoids declaration emit
// inferring the un-nameable internal `registration.js` type through the helper indirection (TS2742),
// while keeping the exports valid Convex function registrations at runtime. The loose arg/return
// types are immaterial: the client calls these by string-path ref, not via these `.d.ts` types.

/**
 * Record a query spec under `name`, build it with `queryGeneric`, and return the live function so
 * the matching `const <name> = defineQuery("<name>", …)` keeps its original runtime shape.
 */
function defineQuery(
  name: string,
  spec: { args: object; returns?: unknown; handler: (ctx: QCtx, args: any) => unknown },
): RegisteredQuery<"public", any, any> {
  HANDLERS[name] = { kind: "query", ...spec } as QuerySpec;
  return queryGeneric(spec as Parameters<typeof queryGeneric>[0]);
}

/** Record a mutation spec under `name`, build it with `mutationGeneric`, and return the live fn. */
function defineMutation(
  name: string,
  spec: { args: object; returns?: unknown; handler: (ctx: MCtx, args: any) => unknown },
): RegisteredMutation<"public", any, any> {
  HANDLERS[name] = { kind: "mutation", ...spec } as MutationSpec;
  return mutationGeneric(spec as Parameters<typeof mutationGeneric>[0]);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const createSession = defineMutation("createSession", {
  args: { session: sessionValidator },
  returns: v.null(),
  handler: async (ctx: MCtx, { session }) => {
    await ctx.db.insert(tables.session, {
      sessionId: session.id,
      agentId: session.agentId,
      createdAt: session.createdAt,
      ...(session.userId !== undefined ? { userId: session.userId } : {}),
      ...(session.orgId !== undefined ? { orgId: session.orgId } : {}),
      ...(session.apiKey !== undefined ? { apiKey: session.apiKey } : {}),
    });
    return null;
  },
});

const getSession = defineQuery("getSession", {
  args: { id: v.string() },
  handler: async (ctx: QCtx, { id }) => {
    const row = await ctx.db
      .query(tables.session)
      .withIndex("by_session_id", (q: any) => q.eq("sessionId", id))
      .first();
    if (!row) return null;
    return {
      id: row.sessionId,
      agentId: row.agentId,
      createdAt: row.createdAt,
      ...(row.userId !== undefined ? { userId: row.userId } : {}),
      ...(row.orgId !== undefined ? { orgId: row.orgId } : {}),
      ...(row.apiKey !== undefined ? { apiKey: row.apiKey } : {}),
    };
  },
});

const listSessions = defineQuery("listSessions", {
  args: {
    agentId: v.optional(v.string()),
    limit: v.optional(v.number()),
    userId: v.optional(v.string()),
    orgId: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx: QCtx, { agentId, limit, userId, orgId, apiKey }) => {
    let rows;
    if (agentId !== undefined) {
      rows = await ctx.db
        .query(tables.session)
        .withIndex("by_agent", (q: any) => q.eq("agentId", agentId))
        .collect();
    } else {
      rows = await ctx.db.query(tables.session).collect();
    }
    // Fix 2: strict filtering — exact matches only when a principal filter is given.
    if (userId !== undefined) rows = rows.filter((r: any) => r.userId === userId);
    if (orgId !== undefined) rows = rows.filter((r: any) => r.orgId === orgId);
    if (apiKey !== undefined) rows = rows.filter((r: any) => r.apiKey === apiKey);
    // Newest-first by createdAt (string ISO compare matches the libsql ORDER BY created_at DESC).
    rows.sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const sliced = limit !== undefined ? rows.slice(0, limit) : rows;
    return sliced.map((r: any) => ({
      id: r.sessionId,
      agentId: r.agentId,
      createdAt: r.createdAt,
      ...(r.userId !== undefined ? { userId: r.userId } : {}),
      ...(r.orgId !== undefined ? { orgId: r.orgId } : {}),
      ...(r.apiKey !== undefined ? { apiKey: r.apiKey } : {}),
    }));
  },
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const appendEvents = defineMutation("appendEvents", {
  args: { events: v.array(eventValidator) },
  returns: v.null(),
  handler: async (ctx: MCtx, { events }) => {
    if (events.length === 0) return null;

    // Conflict check phase: detect dup id, dup (sessionId, seq), and intra-batch dups BEFORE any
    // insert. Throwing here aborts the whole mutation transaction, so nothing is partially applied.
    const seenId = new Set<string>();
    const seenSeq = new Set<string>();
    for (const e of events) {
      const seqKey = `${e.sessionId}#${e.seq}`;
      if (seenId.has(e.id)) throw new Error(`${CONFLICT_PREFIX} duplicate event id ${e.id} (intra-batch)`);
      if (seenSeq.has(seqKey)) throw new Error(`${CONFLICT_PREFIX} duplicate (session ${e.sessionId}, seq ${e.seq}) (intra-batch)`);
      seenId.add(e.id);
      seenSeq.add(seqKey);

      const dupId = await ctx.db
        .query(tables.event)
        .withIndex("by_ext_id", (q: any) => q.eq("id", e.id))
        .first();
      if (dupId) throw new Error(`${CONFLICT_PREFIX} duplicate event id ${e.id}`);

      const dupSeq = await ctx.db
        .query(tables.event)
        .withIndex("by_session_seq", (q: any) => q.eq("sessionId", e.sessionId).eq("seq", e.seq))
        .first();
      if (dupSeq) throw new Error(`${CONFLICT_PREFIX} duplicate (session ${e.sessionId}, seq ${e.seq})`);
    }

    // Write phase — all inserts in the same transaction.
    for (const e of events) {
      await ctx.db.insert(tables.event, {
        id: e.id,
        sessionId: e.sessionId,
        seq: e.seq,
        kind: e.kind,
        schemaVersion: e.schemaVersion,
        payload: e.payload,
        ...(e.meta !== undefined ? { meta: e.meta } : {}),
        createdAt: e.createdAt,
      });
    }
    return null;
  },
});

const readEvents = defineQuery("readEvents", {
  args: { sessionId: v.string() },
  handler: async (ctx: QCtx, { sessionId }) => {
    const rows = await ctx.db
      .query(tables.event)
      .withIndex("by_session_seq", (q: any) => q.eq("sessionId", sessionId))
      .collect();
    // by_session_seq already orders ascending by seq within the session.
    return rows.map((r: any) => ({
      id: r.id,
      sessionId: r.sessionId,
      seq: r.seq,
      kind: r.kind,
      schemaVersion: r.schemaVersion,
      payload: r.payload,
      ...(r.meta !== undefined ? { meta: r.meta } : {}),
      createdAt: r.createdAt,
    }));
  },
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const getBlocks = defineQuery("getBlocks", {
  args: { scopeKey: v.string() },
  handler: async (ctx: QCtx, { scopeKey }) => {
    const rows = await ctx.db
      .query(tables.block)
      .withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    return rows.map(stripBlock);
  },
});

const getBlock = defineQuery("getBlock", {
  args: { scopeKey: v.string(), label: v.string() },
  handler: async (ctx: QCtx, { scopeKey, label }) => {
    const row = await ctx.db
      .query(tables.block)
      .withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey).eq("label", label))
      .first();
    return row ? stripBlock(row) : null;
  },
});

const upsertBlock = defineMutation("upsertBlock", {
  args: {
    scopeKey: v.string(),
    label: v.string(),
    value: v.string(),
    expectVersion: v.optional(v.number()),
    now: v.string(),
  },
  handler: async (ctx: MCtx, { scopeKey, label, value, expectVersion, now }) => {
    const existing = await ctx.db
      .query(tables.block)
      .withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey).eq("label", label))
      .first();

    // CAS: when expectVersion is supplied the block must exist and match.
    if (expectVersion !== undefined && !existing) {
      throw new Error(`${CONFLICT_PREFIX} block ${label} expected version ${expectVersion} but it does not exist`);
    }
    if (expectVersion !== undefined && existing && existing.version !== expectVersion) {
      throw new Error(`${CONFLICT_PREFIX} block ${label} version ${existing.version} != expected ${expectVersion}`);
    }

    const version = existing ? existing.version + 1 : 0;
    if (existing) {
      await ctx.db.patch(existing._id, { value, version, updatedAt: now });
    } else {
      await ctx.db.insert(tables.block, { scopeKey, label, value, version, updatedAt: now });
    }
    // Mirror into the version trail.
    await ctx.db.insert(tables.blockHistory, { scopeKey, label, version, value, updatedAt: now });
    return { label, value, version, updatedAt: now };
  },
});

const appendBlock = defineMutation("appendBlock", {
  args: { scopeKey: v.string(), label: v.string(), text: v.string(), now: v.string() },
  handler: async (ctx: MCtx, { scopeKey, label, text, now }) => {
    const existing = await ctx.db
      .query(tables.block)
      .withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey).eq("label", label))
      .first();
    const value = (existing?.value ?? "") + text; // concat, no separator
    const version = existing ? existing.version + 1 : 0;
    if (existing) {
      await ctx.db.patch(existing._id, { value, version, updatedAt: now });
    } else {
      await ctx.db.insert(tables.block, { scopeKey, label, value, version, updatedAt: now });
    }
    await ctx.db.insert(tables.blockHistory, { scopeKey, label, version, value, updatedAt: now });
    return { label, value, version, updatedAt: now };
  },
});

const getBlockHistory = defineQuery("getBlockHistory", {
  args: { scopeKey: v.string(), label: v.string() },
  handler: async (ctx: QCtx, { scopeKey, label }) => {
    const rows = await ctx.db
      .query(tables.blockHistory)
      .withIndex("by_scope_label_version", (q: any) => q.eq("scopeKey", scopeKey).eq("label", label))
      .collect();
    // by_scope_label_version orders ascending by version within (scopeKey, label).
    return rows.map((r: any) => ({ label: r.label, value: r.value, version: r.version, updatedAt: r.updatedAt }));
  },
});

const listBlocks = defineQuery("listBlocks", {
  args: { scopeKey: v.string() },
  handler: async (ctx: QCtx, { scopeKey }) => {
    const rows = await ctx.db
      .query(tables.block)
      .withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    return rows.map(stripBlock);
  },
});

// ---------------------------------------------------------------------------
// Memory (lexical) — manual TF scoring in the handler
// ---------------------------------------------------------------------------

const indexMemory = defineMutation("indexMemory", {
  args: {
    entries: v.array(
      v.object({
        scopeKey: v.string(),
        id: v.string(),
        text: v.string(),
        ingestedAt: v.optional(v.number()),
        metadata: v.optional(v.any()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx: MCtx, { entries }) => {
    // Delete-then-insert per (scopeKey, extId) — idempotent re-index, scope-isolated.
    for (const e of entries) {
      const existing = await ctx.db
        .query(tables.memory)
        .withIndex("by_scope_ext", (q: any) => q.eq("scopeKey", e.scopeKey).eq("extId", e.id))
        .collect();
      for (const row of existing) await ctx.db.delete(row._id);
    }
    for (const e of entries) {
      await ctx.db.insert(tables.memory, {
        scopeKey: e.scopeKey,
        extId: e.id,
        text: e.text,
        ...(e.ingestedAt !== undefined ? { ingestedAt: e.ingestedAt } : {}),
        ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
      });
    }
    return null;
  },
});

const searchMemory = defineQuery("searchMemory", {
  args: { scopeKey: v.string(), query: v.string(), topK: v.number() },
  handler: async (ctx: QCtx, { scopeKey, query, topK }) => {
    // tokenize → [] on empty/punctuation-only queries (no throw).
    const q = tokenize(query);
    if (q.length === 0) return [];
    const rows = await ctx.db
      .query(tables.memory)
      .withIndex("by_scope", (qq: any) => qq.eq("scopeKey", scopeKey))
      .collect();
    const scored: Array<{
      id: string;
      text: string;
      score: number;
      ingestedAt?: number;
      metadata?: Record<string, unknown>;
    }> = [];
    for (const e of rows) {
      const docTokens = tokenize(e.text);
      if (docTokens.length === 0) continue;
      const freq: Record<string, number> = {};
      for (const t of docTokens) freq[t] = (freq[t] ?? 0) + 1;
      let score = 0;
      for (const qt of q) if (freq[qt]) score += freq[qt] / docTokens.length; // TF, mirrors InMemoryStore
      if (score > 0) {
        scored.push({
          id: e.extId,
          text: e.text,
          score,
          ...(e.ingestedAt !== undefined ? { ingestedAt: e.ingestedAt } : {}),
          ...(e.metadata !== undefined ? { metadata: e.metadata as Record<string, unknown> } : {}),
        });
      }
    }
    return scored.sort((a: any, b: any) => b.score - a.score).slice(0, topK);
  },
});

// ---------------------------------------------------------------------------
// Graph (Facts)
// ---------------------------------------------------------------------------

function rowToFact(r: {
  factId: string;
  subject: string;
  predicate: string;
  object: string;
  objectKind: string;
  validFrom: string;
  validUntil?: string;
  confidence: number;
  source?: string;
  expiresAt?: string;
  supersedes?: string;
  lastCorroboratedAt?: number;
}) {
  return {
    id: r.factId,
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    objectKind: r.objectKind,
    validFrom: r.validFrom,
    ...(r.validUntil !== undefined ? { validUntil: r.validUntil } : {}),
    confidence: r.confidence,
    ...(r.source !== undefined ? { source: r.source } : {}),
    ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
    ...(r.supersedes !== undefined ? { supersedes: r.supersedes } : {}),
    ...(r.lastCorroboratedAt !== undefined ? { lastCorroboratedAt: r.lastCorroboratedAt } : {}),
  };
}

const assertFact = defineMutation("assertFact", {
  args: {
    scopeKey: v.string(),
    factId: v.string(),
    subject: v.string(),
    predicate: v.string(),
    object: v.string(),
    objectKind: v.optional(v.string()),
    validFrom: v.string(),
    confidence: v.optional(v.number()),
    source: v.optional(v.string()),
    ttlMs: v.optional(v.number()),
    expiresAt: v.optional(v.string()),
    lastCorroboratedAt: v.optional(v.number()),
  },
  handler: async (ctx: MCtx, a) => {
    const objectKind = a.objectKind ?? "literal";
    const confidence = a.confidence ?? 1;
    const validFrom = a.validFrom;

    // A single mutation is one transaction, so the read-check-write below is atomic; no JS mutex
    // is needed (unlike libsql's per-connection serialization).
    const current = await ctx.db
      .query(tables.fact)
      .withIndex("by_scope_subject_predicate", (q: any) =>
        q.eq("scopeKey", a.scopeKey).eq("subject", a.subject).eq("predicate", a.predicate),
      )
      .collect();
    const currentValid = current.filter((f: any) => f.validUntil === undefined);

    // Idempotent: same object already currently valid → no new row, no invalidation.
    const same = currentValid.find((f: any) => f.object === a.object);
    if (same) {
      return { asserted: rowToFact(same), invalidated: [] };
    }

    // Guard: new validFrom must not precede any currently-valid prior fact's validFrom.
    for (const f of currentValid) {
      if (validFrom < f.validFrom) {
        throw new Error(
          `temporal order violation: validFrom '${validFrom}' is earlier than the current fact's validFrom '${f.validFrom}'`,
        );
      }
    }

    // State-transition link: when exactly one prior fact is superseded, record its id.
    const supersedes = currentValid.length === 1 ? currentValid[0]!.factId : undefined;

    const invalidated = [];
    for (const f of currentValid) {
      await ctx.db.patch(f._id, { validUntil: validFrom });
      invalidated.push(rowToFact({ ...f, validUntil: validFrom }));
    }

    const expiresAt =
      a.ttlMs !== undefined
        ? new Date(new Date(validFrom).getTime() + a.ttlMs).toISOString()
        : a.expiresAt;
    const lastCorroboratedRaw = a.lastCorroboratedAt ?? Date.parse(validFrom);
    const lastCorroboratedAt = Number.isNaN(lastCorroboratedRaw) ? undefined : lastCorroboratedRaw;

    await ctx.db.insert(tables.fact, {
      factId: a.factId,
      scopeKey: a.scopeKey,
      subject: a.subject,
      predicate: a.predicate,
      object: a.object,
      objectKind,
      validFrom,
      confidence,
      ...(a.source !== undefined ? { source: a.source } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(lastCorroboratedAt !== undefined ? { lastCorroboratedAt } : {}),
    });

    const asserted = {
      id: a.factId,
      subject: a.subject,
      predicate: a.predicate,
      object: a.object,
      objectKind,
      validFrom,
      confidence,
      ...(a.source !== undefined ? { source: a.source } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(lastCorroboratedAt !== undefined ? { lastCorroboratedAt } : {}),
    };
    return { asserted, invalidated };
  },
});

const queryFacts = defineQuery("queryFacts", {
  args: {
    scopeKey: v.string(),
    subject: v.optional(v.string()),
    predicate: v.optional(v.string()),
    object: v.optional(v.string()),
    validAt: v.optional(v.string()),
    includeInvalidated: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx: QCtx, a) => {
    let rows;
    if (a.subject !== undefined && a.predicate !== undefined) {
      rows = await ctx.db
        .query(tables.fact)
        .withIndex("by_scope_subject_predicate", (q: any) =>
          q.eq("scopeKey", a.scopeKey).eq("subject", a.subject!).eq("predicate", a.predicate!),
        )
        .collect();
    } else {
      rows = await ctx.db
        .query(tables.fact)
        .withIndex("by_scope", (q: any) => q.eq("scopeKey", a.scopeKey))
        .collect();
    }
    let out = rows
      .filter((f: any) => (a.subject === undefined ? true : f.subject === a.subject))
      .filter((f: any) => (a.predicate === undefined ? true : f.predicate === a.predicate))
      .filter((f: any) => (a.object === undefined ? true : f.object === a.object))
      .filter((f: any) => {
        if (a.validAt !== undefined) {
          return f.validFrom <= a.validAt && (f.validUntil === undefined || f.validUntil > a.validAt);
        }
        if (a.includeInvalidated) return true;
        return f.validUntil === undefined;
      })
      .sort((x: any, y: any) => (x.validFrom < y.validFrom ? -1 : x.validFrom > y.validFrom ? 1 : 0))
      .map(rowToFact);
    if (a.limit !== undefined) out = out.slice(0, a.limit);
    return out;
  },
});

const corroborate = defineMutation("corroborate", {
  args: { scopeKey: v.string(), factId: v.string(), at: v.number() },
  returns: v.number(),
  handler: async (ctx: MCtx, { scopeKey, factId, at }) => {
    const row = await ctx.db
      .query(tables.fact)
      .withIndex("by_fact_id", (q: any) => q.eq("factId", factId))
      .first();
    if (!row || row.scopeKey !== scopeKey || row.validUntil !== undefined) return 0;
    await ctx.db.patch(row._id, { lastCorroboratedAt: at });
    return 1;
  },
});

const expireFacts = defineMutation("expireFacts", {
  args: { scopeKey: v.string(), ids: v.array(v.string()), at: v.string() },
  returns: v.number(),
  handler: async (ctx: MCtx, { scopeKey, ids, at }) => {
    const idSet = new Set(ids);
    let count = 0;
    const rows = await ctx.db
      .query(tables.fact)
      .withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    for (const f of rows) {
      if (f.validUntil === undefined && idSet.has(f.factId)) {
        await ctx.db.patch(f._id, { validUntil: at });
        count += 1;
      }
    }
    return count;
  },
});

const sweepExpired = defineMutation("sweepExpired", {
  args: { scopeKey: v.string(), now: v.string() },
  returns: v.number(),
  handler: async (ctx: MCtx, { scopeKey, now }) => {
    let count = 0;
    const rows = await ctx.db
      .query(tables.fact)
      .withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    for (const f of rows) {
      if (f.validUntil === undefined && f.expiresAt !== undefined && f.expiresAt <= now) {
        await ctx.db.patch(f._id, { validUntil: now }); // invalidate, NOT delete (temporal audit)
        count += 1;
      }
    }
    return count;
  },
});

// ---------------------------------------------------------------------------
// eraseScope (StorePort §15) — facts + memories + blocks + history + events + sessions
// ---------------------------------------------------------------------------

const eraseScope = defineMutation("eraseScope", {
  args: { scopeKey: v.string(), agentId: v.optional(v.string()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx: MCtx, { scopeKey, agentId }) => {
    let deleted = 0;

    const facts = await ctx.db.query(tables.fact).withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey)).collect();
    for (const r of facts) { await ctx.db.delete(r._id); deleted += 1; }
    const memories = await ctx.db.query(tables.memory).withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey)).collect();
    for (const r of memories) { await ctx.db.delete(r._id); deleted += 1; }
    const history = await ctx.db.query(tables.blockHistory).withIndex("by_scope_label_version", (q: any) => q.eq("scopeKey", scopeKey)).collect();
    for (const r of history) { await ctx.db.delete(r._id); deleted += 1; }
    const blocks = await ctx.db.query(tables.block).withIndex("by_scope_label", (q: any) => q.eq("scopeKey", scopeKey)).collect();
    for (const r of blocks) { await ctx.db.delete(r._id); deleted += 1; }

    // Sessions are agent-scoped (no per-user scope_key). Erase all sessions for this agentId and
    // their events. Mirrors libsql/InMemoryStore semantics.
    if (agentId !== undefined) {
      const sessions = await ctx.db
        .query(tables.session)
        .withIndex("by_agent", (q: any) => q.eq("agentId", agentId))
        .collect();
      for (const s of sessions) {
        const events = await ctx.db
          .query(tables.event)
          .withIndex("by_session_seq", (q: any) => q.eq("sessionId", s.sessionId))
          .collect();
        for (const e of events) {
          await ctx.db.delete(e._id);
          deleted += 1;
        }
        await ctx.db.delete(s._id);
        deleted += 1;
      }
    }

    return { deleted };
  },
});

// ---------------------------------------------------------------------------
// Vectors (VectorPort) — manual cosine scoring in the handler
// ---------------------------------------------------------------------------

const vectorUpsert = defineMutation("vectorUpsert", {
  args: {
    id: v.string(),
    scopeKey: v.string(),
    text: v.string(),
    vector: v.array(v.number()),
  },
  returns: v.null(),
  handler: async (ctx: MCtx, { id, scopeKey, text, vector }) => {
    // Idempotent by (scopeKey, extId): delete-then-insert.
    const existing = await ctx.db
      .query(tables.vector)
      .withIndex("by_scope_ext", (q: any) => q.eq("scopeKey", scopeKey).eq("extId", id))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert(tables.vector, { extId: id, scopeKey, text, vector });
    return null;
  },
});

const vectorSearch = defineQuery("vectorSearch", {
  args: { queryVector: v.array(v.number()), scopeKey: v.string(), topK: v.number() },
  handler: async (ctx: QCtx, { queryVector, scopeKey, topK }) => {
    const rows = await ctx.db
      .query(tables.vector)
      .withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0,
        ma = 0,
        mb = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        dot += a[i]! * b[i]!;
        ma += a[i]! * a[i]!;
        mb += b[i]! * b[i]!;
      }
      return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
    };
    return rows
      .map((e: any) => ({ id: e.extId, text: e.text, score: cosine(queryVector, e.vector) }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, topK);
  },
});

const vectorDelete = defineMutation("vectorDelete", {
  args: { id: v.string(), scopeKey: v.string() },
  returns: v.null(),
  handler: async (ctx: MCtx, { id, scopeKey }) => {
    const rows = await ctx.db
      .query(tables.vector)
      .withIndex("by_scope_ext", (q: any) => q.eq("scopeKey", scopeKey).eq("extId", id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

const vectorEraseScope = defineMutation("vectorEraseScope", {
  args: { scopeKey: v.string() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx: MCtx, { scopeKey }) => {
    const rows = await ctx.db
      .query(tables.vector)
      .withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { deleted };
  },
});

const vectorList = defineQuery("vectorList", {
  args: { scopeKey: v.string() },
  handler: async (ctx: QCtx, { scopeKey }) => {
    const rows = await ctx.db
      .query(tables.vector)
      .withIndex("by_scope", (q: any) => q.eq("scopeKey", scopeKey))
      .collect();
    return rows.map((e: any) => ({ id: e.extId, scopeKey: e.scopeKey, text: e.text, vector: e.vector }));
  },
});

// ---------------------------------------------------------------------------
// Durable (DurablePort) — checkpoints + idempotency ledger + suspension decisions
//
// Each operation is a single Convex mutation/query, so the read-then-write below is one
// serializable transaction (OCC) — exactly the exactly-once guarantee §9.3 needs. No JS mutex.
// ---------------------------------------------------------------------------

const writeCheckpoint = defineMutation("writeCheckpoint", {
  args: { sessionId: v.string(), seq: v.number(), hash: v.string(), now: v.string() },
  returns: v.null(),
  handler: async (ctx: MCtx, { sessionId, seq, hash, now }) => {
    // Idempotent per (sessionId, seq): update the hash in place, never duplicate the row.
    const existing = await ctx.db
      .query(tables.checkpoint)
      .withIndex("by_session_seq", (q: any) => q.eq("sessionId", sessionId).eq("seq", seq))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { hash, createdAt: now });
    } else {
      await ctx.db.insert(tables.checkpoint, { sessionId, seq, hash, createdAt: now });
    }
    return null;
  },
});

const lastCheckpoint = defineQuery("lastCheckpoint", {
  args: { sessionId: v.string() },
  handler: async (ctx: QCtx, { sessionId }) => {
    // by_session_seq orders ascending by seq within the session — take the last (highest seq).
    const row = await ctx.db
      .query(tables.checkpoint)
      .withIndex("by_session_seq", (q: any) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();
    if (!row) return null;
    return { sessionId: row.sessionId, seq: row.seq, hash: row.hash, createdAt: row.createdAt };
  },
});

const recordIntent = defineMutation("recordIntent", {
  args: {
    key: v.string(),
    argsHash: v.string(),
    now: v.string(),
    scopeKey: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    ownerKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx: MCtx, { key, argsHash, now, scopeKey, sessionId, ownerKey }) => {
    // Write-once: an existing row is left untouched so a re-run cannot downgrade applied → intent.
    const existing = await ctx.db
      .query(tables.idempotency)
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();
    if (existing) return null;
    await ctx.db.insert(tables.idempotency, {
      key,
      status: "intent",
      argsHash,
      createdAt: now,
      ...(scopeKey !== undefined ? { scopeKey } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(ownerKey !== undefined ? { ownerKey } : {}),
    });
    return null;
  },
});

const recordCompletion = defineMutation("recordCompletion", {
  args: {
    key: v.string(),
    result: v.string(),
    now: v.string(),
    scopeKey: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    ownerKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx: MCtx, { key, result, now, scopeKey, sessionId, ownerKey }) => {
    // Flip to applied + persist the (already JSON-serialized) result. Cover completion without a
    // prior intent by inserting. `result` is always set so a stored "null" is distinguishable from
    // an intent row (which has no `result` field) — i.e. "no result yet".
    const existing = await ctx.db
      .query(tables.idempotency)
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "applied",
        result,
        ...(scopeKey !== undefined ? { scopeKey } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(ownerKey !== undefined ? { ownerKey } : {}),
      });
    } else {
      await ctx.db.insert(tables.idempotency, {
        key,
        status: "applied",
        argsHash: "",
        result,
        createdAt: now,
        ...(scopeKey !== undefined ? { scopeKey } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(ownerKey !== undefined ? { ownerKey } : {}),
      });
    }
    return null;
  },
});

const getIdempotency = defineQuery("getIdempotency", {
  args: {
    key: v.string(),
    scopeKey: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    ownerKey: v.optional(v.string()),
  },
  handler: async (ctx: QCtx, { key }) => {
    const row = await ctx.db
      .query(tables.idempotency)
      .withIndex("by_key", (q: any) => q.eq("key", key))
      .first();
    if (!row) return null;
    // `result` stays a JSON string across the wire — the client parses it. Returning a parsed
    // object here would re-sort its keys (Convex normalizes value key order on the return boundary).
    return {
      key: row.key,
      argsHash: row.argsHash,
      status: row.status,
      ...(row.result !== undefined ? { result: row.result } : {}),
      createdAt: row.createdAt,
      ...(row.scopeKey !== undefined ? { scopeKey: row.scopeKey } : {}),
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      ...(row.ownerKey !== undefined ? { ownerKey: row.ownerKey } : {}),
    };
  },
});

const recordDecision = defineMutation("recordDecision", {
  args: { sessionId: v.string(), callId: v.string(), decision: v.string(), now: v.string() },
  returns: v.null(),
  handler: async (ctx: MCtx, { sessionId, callId, decision, now }) => {
    // Upsert per (sessionId, callId) — write-once in practice; last write wins on a re-record.
    // `decision` arrives JSON-serialized so its object-key order round-trips faithfully.
    const existing = await ctx.db
      .query(tables.decision)
      .withIndex("by_session_call", (q: any) => q.eq("sessionId", sessionId).eq("callId", callId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { decision, createdAt: now });
    } else {
      await ctx.db.insert(tables.decision, { sessionId, callId, decision, createdAt: now });
    }
    return null;
  },
});

const getDecision = defineQuery("getDecision", {
  args: { sessionId: v.string(), callId: v.string() },
  handler: async (ctx: QCtx, { sessionId, callId }) => {
    const row = await ctx.db
      .query(tables.decision)
      .withIndex("by_session_call", (q: any) => q.eq("sessionId", sessionId).eq("callId", callId))
      .first();
    // Return the JSON string; the client parses it (parsing here would re-sort object keys).
    return row ? row.decision : null;
  },
});


  return {
    functions: {
      createSession,
      getSession,
      listSessions,
      appendEvents,
      readEvents,
      getBlocks,
      getBlock,
      upsertBlock,
      appendBlock,
      getBlockHistory,
      listBlocks,
      indexMemory,
      searchMemory,
      assertFact,
      queryFacts,
      corroborate,
      expireFacts,
      sweepExpired,
      eraseScope,
      vectorUpsert,
      vectorSearch,
      vectorDelete,
      vectorEraseScope,
      vectorList,
      writeCheckpoint,
      lastCheckpoint,
      recordIntent,
      recordCompletion,
      getIdempotency,
      recordDecision,
      getDecision,
    },
    handlers: HANDLERS,
  };
}

// ---------------------------------------------------------------------------
// Authorized factory support
// ---------------------------------------------------------------------------

export function authorizeEidenticHandlers(
  handlerSet: EidenticHandlerSet,
  authorize?: EidenticAuthorize,
): Record<string, EidenticRegisteredFunction> {
  if (!authorize) return handlerSet.functions;

  const out: Record<string, EidenticRegisteredFunction> = {};
  for (const [op, spec] of Object.entries(handlerSet.handlers)) {
    const base = spec.handler as (ctx: unknown, args: Record<string, unknown>) => unknown;
    const handler = async (ctx: unknown, args: Record<string, unknown>): Promise<unknown> => {
      await authorize(ctx as QCtx | MCtx, { op, args });
      return base(ctx, args);
    };
    const def = {
      args: spec.args,
      ...(spec.returns !== undefined ? { returns: spec.returns } : {}),
      handler,
    };
    out[op] =
      spec.kind === "mutation"
        ? mutationGeneric(def as Parameters<typeof mutationGeneric>[0])
        : queryGeneric(def as Parameters<typeof queryGeneric>[0]);
  }
  return out;
}
