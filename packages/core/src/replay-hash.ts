import { sha256Hex } from "./sha256.js";
import type { StoredEvent } from "@eidentic/types";
import { canonicalJson } from "@eidentic/types";

export const REPLAY_HASH_ALGORITHM = "eidentic-chain-sha256-v1" as const;

/** Fold one durable event into the versioned replay hash chain. */
export async function chainHash(prev: string, event: StoredEvent): Promise<string> {
  return sha256Hex(prev + canonicalJson({ kind: event.kind, payload: event.payload }));
}

/**
 * Deterministic content hash of the replay-state projection (§9.1 projection 1): hashes only
 * `{ kind, payload }` per event, in sequence order, EXCLUDING `meta` (cost/timing/trace) and
 * volatile fields (`id`, `createdAt`). Two functionally identical runs hash identically, so
 * checkpoint dedup and resume-consistency work.
 */
export async function replayHash(events: StoredEvent[]): Promise<string> {
  let hash = "";
  for (const event of events) hash = await chainHash(hash, event);
  return hash;
}
