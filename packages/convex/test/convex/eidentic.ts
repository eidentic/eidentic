/**
 * The host app's functions module, as a test fixture. The user re-exports the package handlers
 * from a file in their `convex/` dir. Conformance intentionally opts into the legacy unguarded
 * object; production top-level exports are fail-closed and hosts should use an authorize hook.
 */
import { unsafeLegacyPublicEidenticFunctions } from "../../src/server.js";

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
} = unsafeLegacyPublicEidenticFunctions;
