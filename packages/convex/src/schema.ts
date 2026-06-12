/**
 * Eidentic Convex schema.
 *
 * `eidenticTables` is a record of `defineTable(...)` definitions the host app spreads into its
 * own `defineSchema`. Every table is keyed by a pre-computed `scopeKey` string (see
 * `scopeKey(scope)` in `@eidentic/types`) so the adapter never needs to reconstruct a `Scope`
 * server-side. IDs that cross the client boundary (event ids, fact ids, block labels) are stored
 * as plain string fields — NOT Convex document `_id`s — so the runtime can address rows by the
 * identifiers it already owns.
 *
 * Usage in the host app's `convex/schema.ts`:
 *
 *   import { defineSchema } from "convex/server";
 *   import { eidenticTables } from "@eidentic/convex/schema";
 *
 *   export default defineSchema({
 *     ...eidenticTables,
 *     // ...your own tables
 *   });
 *
 * NOTE on search: lexical (`memories`) and vector (`vectors`) ranking is done by manual scoring in
 * the function handlers (deterministic + testable), NOT by Convex native `searchIndex` /
 * `vectorIndex`. Adding native indexes here is a future performance optimization — see README.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const eidenticTables = {
  // Session records. Owned by an agentId; optionally by a user/org/apiKey (multi-tenant).
  sessions: defineTable({
    sessionId: v.string(),
    agentId: v.string(),
    createdAt: v.string(),
    userId: v.optional(v.string()),
    orgId: v.optional(v.string()),
    apiKey: v.optional(v.string()),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_agent", ["agentId"]),

  // Append-only event log. UNIQUE(sessionId, seq) and UNIQUE(id) are enforced in the
  // appendEvents mutation (Convex has no DB-level unique constraints).
  events: defineTable({
    id: v.string(),
    sessionId: v.string(),
    seq: v.number(),
    kind: v.string(),
    schemaVersion: v.number(),
    payload: v.any(),
    meta: v.optional(v.any()),
    createdAt: v.string(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    .index("by_ext_id", ["id"]),

  // Always-in-context memory blocks. One row per (scopeKey, label); CAS via `version`.
  blocks: defineTable({
    scopeKey: v.string(),
    label: v.string(),
    value: v.string(),
    version: v.number(),
    updatedAt: v.string(),
  }).index("by_scope_label", ["scopeKey", "label"]),

  // Full ascending version trail for every block write.
  blockHistory: defineTable({
    scopeKey: v.string(),
    label: v.string(),
    version: v.number(),
    value: v.string(),
    updatedAt: v.string(),
  }).index("by_scope_label_version", ["scopeKey", "label", "version"]),

  // Lexical memory index. One row per (scopeKey, extId); re-index is delete-then-insert.
  memories: defineTable({
    scopeKey: v.string(),
    extId: v.string(),
    text: v.string(),
    ingestedAt: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_scope", ["scopeKey"])
    .index("by_scope_ext", ["scopeKey", "extId"]),

  // Temporal knowledge graph. Currently-valid facts have validUntil === undefined.
  facts: defineTable({
    factId: v.string(),
    scopeKey: v.string(),
    subject: v.string(),
    predicate: v.string(),
    object: v.string(),
    objectKind: v.string(),
    validFrom: v.string(),
    validUntil: v.optional(v.string()),
    confidence: v.number(),
    source: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
    supersedes: v.optional(v.string()),
    lastCorroboratedAt: v.optional(v.number()),
  })
    .index("by_scope", ["scopeKey"])
    .index("by_scope_subject_predicate", ["scopeKey", "subject", "predicate"])
    .index("by_fact_id", ["factId"]),

  // Vector entries. One row per (scopeKey, extId); cosine scoring is done in the handler.
  vectors: defineTable({
    extId: v.string(),
    scopeKey: v.string(),
    text: v.string(),
    vector: v.array(v.number()),
  })
    .index("by_scope", ["scopeKey"])
    .index("by_scope_ext", ["scopeKey", "extId"]),

  // Durable-execution checkpoint markers (§9.1). One row per (sessionId, seq); writeCheckpoint
  // upserts the hash. `by_session_seq` orders ascending by seq within a session so lastCheckpoint
  // reads the highest-seq row.
  checkpoints: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    hash: v.string(),
    createdAt: v.string(),
  }).index("by_session_seq", ["sessionId", "seq"]),

  // Idempotency ledger (§9.3). One row per `key` (uniqueness enforced in the mutations). `status`
  // starts "intent" and flips to "applied" once the side effect succeeds. `result` is a JSON string
  // (present only when applied) so a stored `null` is distinguishable from "no result yet" AND the
  // result's object-key order round-trips faithfully (Convex `v.any()` normalizes key order).
  idempotency: defineTable({
    key: v.string(),
    status: v.union(v.literal("intent"), v.literal("applied")),
    argsHash: v.string(),
    result: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_key", ["key"]),

  // Human-in-the-loop suspension decisions (§9.4). One row per (sessionId, callId); recordDecision
  // upserts the SuspendDecision. Stored as a JSON string so object-key order round-trips faithfully.
  decisions: defineTable({
    sessionId: v.string(),
    callId: v.string(),
    decision: v.string(),
    createdAt: v.string(),
  }).index("by_session_call", ["sessionId", "callId"]),
} as const;
