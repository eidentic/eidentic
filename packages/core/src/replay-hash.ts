import { sha256Hex } from "./sha256.js";
import type { StoredEvent } from "@eidentic/types";
import { canonicalJson } from "@eidentic/types";

/**
 * Deterministic content hash of the replay-state projection (§9.1 projection 1): hashes only
 * `{ kind, payload }` per event, in sequence order, EXCLUDING `meta` (cost/timing/trace) and
 * volatile fields (`id`, `createdAt`). Two functionally identical runs hash identically, so
 * checkpoint dedup and resume-consistency work.
 */
export async function replayHash(events: StoredEvent[]): Promise<string> {
  const projection = events.map((e) => ({ kind: e.kind, payload: e.payload }));
  return sha256Hex(canonicalJson(projection));
}
