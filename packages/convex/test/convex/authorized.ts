/**
 * Test fixture: the eidentic functions built through `eidenticFunctions({ authorize })`, registered
 * under the module path "authorized:<name>" (so a runner using `defaultStoreFns("authorized")` /
 * `defaultVectorFns("authorized")` targets THESE authorized copies instead of the bare exports).
 *
 * The hook is indirected through module-level mutable state (`authState`) so a single test can flip
 * between "deny" and "allow", and capture the `{ op, args }` passed to the hook, without rebuilding
 * the convex-test module map.
 */
import { eidenticFunctions, type EidenticAuthorize } from "../../src/server.js";

/** Mutable control surface the test drives. */
export const authState: {
  mode: "allow" | "deny";
  /** Records every `{ op, args }` the hook saw, newest last. */
  calls: Array<{ op: string; args: Record<string, unknown> }>;
} = { mode: "allow", calls: [] };

const authorize: EidenticAuthorize = (_ctx, info) => {
  authState.calls.push({ op: info.op, args: info.args });
  if (authState.mode === "deny") throw new Error(`unauthorized: ${info.op}`);
};

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
} = eidenticFunctions({ authorize });
