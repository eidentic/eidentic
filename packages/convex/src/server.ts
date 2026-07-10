/**
 * Eidentic Convex app-functions handlers.
 *
 * Top-level legacy exports retain their names but now fail closed. Use `eidenticFunctions` with an
 * authorization hook. The explicitly named unsafe compatibility object exists only for controlled
 * migrations and tests.
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
const denyUnauthenticated: EidenticAuthorize = async () => {
  throw new Error("Eidentic Convex public function denied: configure eidenticFunctions({ authorize })");
};
const deniedDefaultFunctions = authorizeEidenticHandlers(defaultHandlers, denyUnauthenticated);

/** @deprecated Explicitly unsafe legacy public handlers. Prefer `eidenticFunctions({ authorize })`. */
export const unsafeLegacyPublicEidenticFunctions = defaultHandlers.functions;

export const {
  createSession,
  getSession,
  replaceSessionApiKey,
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
  listMemory,
  deleteMemory,
  assertFact,
  queryFacts,
  corroborate,
  expireFacts,
  sweepExpired,
  eraseScope,
  writeCheckpoint,
  lastCheckpoint,
  recordIntent,
  claimIntent,
  releaseIntent,
  recordCompletion,
  getIdempotency,
  recordDecision,
  getDecision,
  vectorUpsert,
  vectorSearch,
  vectorDelete,
  vectorEraseScope,
  vectorList,
} = deniedDefaultFunctions;

export interface EidenticFunctionsOptions {
  /** Optional authorization hook run before every generated handler. */
  authorize?: EidenticAuthorize;
  /** @deprecated Explicitly restore unauthenticated public handlers during a controlled migration. */
  unsafeAllowUnauthenticated?: boolean;
  /** Optional table-name mapping for prefixed/custom app-functions schemas. */
  tables?: EidenticTableNames;
}

/**
 * Build all 36 eidentic functions with an optional authorization hook and optional table map.
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
  const authorize = opts.authorize ?? (opts.unsafeAllowUnauthenticated === true ? undefined : denyUnauthenticated);
  return authorizeEidenticHandlers(handlerSet, authorize);
}
