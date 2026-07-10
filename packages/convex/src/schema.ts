/**
 * Eidentic Convex app-functions schema helpers.
 *
 * The default `eidenticTables` export intentionally preserves the original table names
 * (`sessions`, `events`, `blockHistory`, ...). That keeps every existing consumer's
 * `...eidenticTables` schema spread working unchanged.
 *
 * New installations that still choose the app-functions path can call
 * `createEidenticTableNames({ prefix: "eidentic_" })` and `createEidenticTables({ names })`
 * to avoid host-app table-name collisions. The Convex Component path has its own isolated
 * schema and uses singular snake_case names by default.
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

export type EidenticTableKey =
  | "session"
  | "event"
  | "block"
  | "blockHistory"
  | "memory"
  | "fact"
  | "vector"
  | "checkpoint"
  | "idempotency"
  | "decision";

export type EidenticTableNames = Record<EidenticTableKey, string>;

export const DEFAULT_EIDENTIC_TABLE_NAMES = {
  session: "sessions",
  event: "events",
  block: "blocks",
  blockHistory: "blockHistory",
  memory: "memories",
  fact: "facts",
  vector: "vectors",
  checkpoint: "checkpoints",
  idempotency: "idempotency",
  decision: "decisions",
} as const satisfies EidenticTableNames;

export const SINGULAR_EIDENTIC_TABLE_NAMES = {
  session: "session",
  event: "event",
  block: "block",
  blockHistory: "block_history",
  memory: "memory",
  fact: "fact",
  vector: "vector",
  checkpoint: "checkpoint",
  idempotency: "idempotency",
  decision: "decision",
} as const satisfies EidenticTableNames;

export interface CreateEidenticTableNamesOptions {
  /**
   * Prefix every generated table name. Passing this option switches the generated base names
   * to singular snake_case, e.g. `eidentic_session`, `eidentic_block_history`.
   */
  prefix?: string;
  /** Override individual generated names. Useful when a host app has stricter naming policy. */
  names?: Partial<EidenticTableNames>;
}

export function createEidenticTableNames(opts: CreateEidenticTableNamesOptions = {}): EidenticTableNames {
  const base = opts.prefix === undefined ? DEFAULT_EIDENTIC_TABLE_NAMES : SINGULAR_EIDENTIC_TABLE_NAMES;
  const prefix = opts.prefix ?? "";
  return {
    session: `${prefix}${base.session}`,
    event: `${prefix}${base.event}`,
    block: `${prefix}${base.block}`,
    blockHistory: `${prefix}${base.blockHistory}`,
    memory: `${prefix}${base.memory}`,
    fact: `${prefix}${base.fact}`,
    vector: `${prefix}${base.vector}`,
    checkpoint: `${prefix}${base.checkpoint}`,
    idempotency: `${prefix}${base.idempotency}`,
    decision: `${prefix}${base.decision}`,
    ...opts.names,
  };
}

export interface CreateEidenticTablesOptions {
  /** Complete table-name mapping. Use `createEidenticTableNames` to build this safely. */
  names?: EidenticTableNames;
  /** Convenience shorthand for `names: createEidenticTableNames({ prefix })`. */
  prefix?: string;
}

export function createEidenticTables(opts: CreateEidenticTablesOptions = {}) {
  const names = opts.names ?? createEidenticTableNames(
    opts.prefix === undefined ? {} : { prefix: opts.prefix },
  );

  return {
    // Session records. Owned by an agentId; optionally by a user/org/apiKey (multi-tenant).
    [names.session]: defineTable({
      sessionId: v.string(),
      agentId: v.string(),
      createdAt: v.string(),
      userId: v.optional(v.string()),
      orgId: v.optional(v.string()),
      apiKey: v.optional(v.string()),
    })
      .index("by_session_id", ["sessionId"])
      .index("by_agent", ["agentId"])
      .index("by_agent_user", ["agentId", "userId"])
      .index("by_agent_org", ["agentId", "orgId"]),

    // Append-only event log. Uniqueness is enforced in the appendEvents mutation.
    [names.event]: defineTable({
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
    [names.block]: defineTable({
      scopeKey: v.string(),
      label: v.string(),
      value: v.string(),
      version: v.number(),
      updatedAt: v.string(),
    }).index("by_scope_label", ["scopeKey", "label"]),

    // Full ascending version trail for every block write.
    [names.blockHistory]: defineTable({
      scopeKey: v.string(),
      label: v.string(),
      version: v.number(),
      value: v.string(),
      updatedAt: v.string(),
    }).index("by_scope_label_version", ["scopeKey", "label", "version"]),

    // Lexical memory index. One row per (scopeKey, extId); re-index is delete-then-insert.
    [names.memory]: defineTable({
      scopeKey: v.string(),
      extId: v.string(),
      text: v.string(),
      ingestedAt: v.optional(v.number()),
      metadata: v.optional(v.any()),
    })
      .index("by_scope", ["scopeKey"])
      .index("by_scope_ext", ["scopeKey", "extId"]),

    // Temporal knowledge graph. Currently-valid facts have validUntil === undefined.
    [names.fact]: defineTable({
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
    [names.vector]: defineTable({
      extId: v.string(),
      scopeKey: v.string(),
      text: v.string(),
      vector: v.array(v.number()),
    })
      .index("by_scope", ["scopeKey"])
      .index("by_scope_ext", ["scopeKey", "extId"]),

    // Durable-execution checkpoint markers.
    [names.checkpoint]: defineTable({
      sessionId: v.string(),
      seq: v.number(),
      hash: v.string(),
      createdAt: v.string(),
    }).index("by_session_seq", ["sessionId", "seq"]),

    // Idempotency ledger.
    [names.idempotency]: defineTable({
      key: v.string(),
      status: v.union(v.literal("intent"), v.literal("applied")),
      argsHash: v.string(),
      result: v.optional(v.string()),
      createdAt: v.string(),
      scopeKey: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      ownerKey: v.optional(v.string()),
    })
      .index("by_key", ["key"])
      .index("by_session", ["sessionId"])
      .index("by_scope", ["scopeKey"])
      .index("by_owner", ["ownerKey"]),

    // Human-in-the-loop suspension decisions.
    [names.decision]: defineTable({
      sessionId: v.string(),
      callId: v.string(),
      decision: v.string(),
      createdAt: v.string(),
    }).index("by_session_call", ["sessionId", "callId"]),
  } as const;
}

export const eidenticTables = createEidenticTables();
