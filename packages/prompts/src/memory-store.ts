import type { PromptStore, PromptStoreState } from "./types.js";

/**
 * Default in-memory {@link PromptStore} — state lives only for the lifetime of
 * the process. Useful for tests and short-lived scripts; use
 * {@link filePromptStore} for production persistence.
 */
export function memoryPromptStore(): PromptStore {
  let state: PromptStoreState | undefined;
  let chain: Promise<void> = Promise.resolve();
  return {
    async load() {
      await chain;
      return state;
    },
    save(s) {
      // Deep-clone so callers can't mutate the stored copy through references.
      const operation = chain.then(() => {
        state = JSON.parse(JSON.stringify(s)) as PromptStoreState;
      });
      chain = operation.catch(() => undefined);
      return operation;
    },
    transact<T>(mutator: (state: PromptStoreState) => T | Promise<T>): Promise<T> {
      const operation = chain.then(async () => {
        const working = state
          ? JSON.parse(JSON.stringify(state)) as PromptStoreState
          : { versions: [], tags: {}, history: [] };
        const result = await mutator(working);
        state = JSON.parse(JSON.stringify(working)) as PromptStoreState;
        return result;
      });
      chain = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}
