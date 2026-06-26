/**
 * Eidentic Convex app-functions handlers.
 *
 * Back-compat note: the top-level exports still use the original table names from
 * `eidenticTables`, so `export * from "@eidentic/convex/server"` remains source-compatible.
 * New app-functions installs can use `eidenticFunctions({ tables, authorize })` together with
 * `createEidenticTableNames` / `createEidenticTables` for prefixed table names.
 */
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import {
  DEFAULT_EIDENTIC_TABLE_NAMES,
  type EidenticTableNames,
} from "./schema.js";
import {
  authorizeEidenticHandlers,
  defineEidenticHandlers,
  type EidenticAuthorize,
} from "./app-functions/handlers.js";

export type { EidenticAuthorize } from "./app-functions/handlers.js";

type EidenticRegisteredFunction = RegisteredMutation<"public", any, any> | RegisteredQuery<"public", any, any>;

const defaultHandlers = defineEidenticHandlers(DEFAULT_EIDENTIC_TABLE_NAMES);

export const {
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
  writeCheckpoint,
  lastCheckpoint,
  recordIntent,
  recordCompletion,
  getIdempotency,
  recordDecision,
  getDecision,
  vectorUpsert,
  vectorSearch,
  vectorDelete,
  vectorEraseScope,
  vectorList,
} = defaultHandlers.functions;

export interface EidenticFunctionsOptions {
  /** Optional authorization hook run before every generated handler. */
  authorize?: EidenticAuthorize;
  /** Optional table-name mapping for prefixed/custom app-functions schemas. */
  tables?: EidenticTableNames;
}

/**
 * Build all 31 eidentic functions with an optional authorization hook and optional table map.
 *
 * Use this in a host app's `convex/eidentic.ts` when the functions are reachable over HTTP:
 *
 * ```ts
 * import { eidenticFunctions } from "@eidentic/convex/server";
 *
 * export const { getBlocks, upsertBlock } = eidenticFunctions({
 *   authorize: async (ctx, { args }) => {
 *     const identity = await ctx.auth.getUserIdentity();
 *     if (!identity) throw new Error("unauthenticated");
 *     // Assert `args.scopeKey`, `args.sessionId`, or `args.ownerKey` ownership here.
 *   },
 * });
 * ```
 */
export function eidenticFunctions(opts: EidenticFunctionsOptions = {}): Record<string, EidenticRegisteredFunction> {
  const handlerSet = opts.tables ? defineEidenticHandlers(opts.tables) : defaultHandlers;
  return authorizeEidenticHandlers(handlerSet, opts.authorize);
}
