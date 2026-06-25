import { defineEidenticHandlers } from "../app-functions/handlers.js";
import { EIDENTIC_COMPONENT_TABLE_NAMES } from "./schema.js";

const componentHandlers = defineEidenticHandlers(EIDENTIC_COMPONENT_TABLE_NAMES);

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
} = componentHandlers.functions;
