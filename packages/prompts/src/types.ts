// ─── Core data types ─────────────────────────────────────────────────────────

/**
 * A single immutable snapshot of a prompt body at a given version.
 * Once created, a PromptVersion is never mutated — rollback is accomplished by
 * moving the "stable" tag to an earlier version, not by editing records.
 */
export interface PromptVersion {
  /** Logical name of the prompt (e.g. "support-agent-system"). */
  name: string;
  /** Monotonically incrementing integer, starting at 1. */
  version: number;
  /** SHA-256 hex digest of `body`. Two identical bodies share a hash → dedup. */
  hash: string;
  /** The raw prompt text. */
  body: string;
  /** ISO-8601 timestamp of when this version was registered. */
  createdAt: string;
  /** Arbitrary key/value tags for filtering (e.g. { env: "prod" }). */
  tags: Record<string, string>;
  /** Arbitrary caller-supplied metadata (model, owner, ticket, …). */
  meta: Record<string, unknown>;
}

// ─── History / audit ─────────────────────────────────────────────────────────

/** A version was registered for a prompt name. */
export interface VersionRegisteredEvent {
  kind: "version_registered";
  name: string;
  version: number;
  hash: string;
  createdAt: string;
}

/** A named tag was moved (or created) to point at a version. */
export interface TagMovedEvent {
  kind: "tag_moved";
  name: string;
  tag: string;
  /** Previous version the tag pointed at, or null if the tag is new. */
  fromVersion: number | null;
  toVersion: number;
  createdAt: string;
}

/** A named tag was removed from a prompt. */
export interface TagRemovedEvent {
  kind: "tag_removed";
  name: string;
  tag: string;
  /** Version the tag pointed at when it was removed. */
  fromVersion: number;
  createdAt: string;
}

export type HistoryEvent =
  | VersionRegisteredEvent
  | TagMovedEvent
  | TagRemovedEvent;

// ─── Store interface ──────────────────────────────────────────────────────────

/**
 * The full serialisable state managed by a PromptStore.
 * `save` / `load` operate on this shape as plain JSON.
 */
export interface PromptStoreState {
  versions: PromptVersion[];
  /** tag name → version number, keyed as `"<promptName>/<tag>"`. */
  tags: Record<string, number>;
  history: HistoryEvent[];
}

/**
 * Persistence adapter for a prompt registry.
 *
 * Implement this interface to store prompt state in any backend.
 * The built-in implementations are an in-memory store (default) and
 * {@link filePromptStore} (crash-safe JSON file).
 */
export interface PromptStore {
  /** Load the full state. Returns `undefined` when the store is empty. */
  load(): Promise<PromptStoreState | undefined>;
  /** Persist the full state snapshot. */
  save(state: PromptStoreState): Promise<void>;
}

// ─── Canary result ────────────────────────────────────────────────────────────

/**
 * Result returned by `registry.canary(...)`.
 * Callers should record `arm` alongside eval metadata for offline analysis.
 */
export interface CanaryResult {
  /** The resolved prompt body for this key. */
  body: string;
  /** The resolved version number. */
  version: number;
  /** Which traffic arm this key was assigned to. */
  arm: "stable" | "candidate";
}
