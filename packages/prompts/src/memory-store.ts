import type { PromptStore, PromptStoreState } from "./types.js";

/**
 * Default in-memory {@link PromptStore} — state lives only for the lifetime of
 * the process. Useful for tests and short-lived scripts; use
 * {@link filePromptStore} for production persistence.
 */
export function memoryPromptStore(): PromptStore {
  let state: PromptStoreState | undefined;
  return {
    async load() {
      return state;
    },
    async save(s) {
      // Deep-clone so callers can't mutate the stored copy through references.
      state = JSON.parse(JSON.stringify(s)) as PromptStoreState;
    },
  };
}
