import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PromptStore, PromptStoreState } from "./types.js";

// ─── filePromptStore() ────────────────────────────────────────────────────────
//
// A crash-safe, single-file JSON store for prompt registry state.
//
// Design — atomic rename (mirrors packages/workflow/src/file-store.ts):
//   Each `save()` writes the full state snapshot to `${path}.tmp`, then
//   `rename()`s it over `path`. POSIX `rename` is atomic, so a crash mid-write
//   leaves either the old complete file or the new complete file — never a torn
//   one. Writes are serialised through an internal promise chain so concurrent
//   `save()` calls don't race on the same file.

/**
 * Create a {@link PromptStore} backed by a single JSON file at `path`.
 *
 * Crash-safety: each write is a full snapshot written to `${path}.tmp` then
 * atomically `rename`d over `path`. A crash never leaves a partially-written
 * file. Parent directories are created on first write.
 *
 * @param path — absolute or relative path to the JSON file.
 */
export function filePromptStore(path: string): PromptStore {
  const tmpPath = `${path}.tmp`;

  // Serialise all disk writes through this chain.
  let writeChain: Promise<void> = Promise.resolve();

  return {
    async load(): Promise<PromptStoreState | undefined> {
      try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw) as PromptStoreState;
      } catch (err: unknown) {
        // Missing file → empty store. Any other error is rethrown so the caller
        // knows persistence is broken rather than silently empty.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return undefined;
      }
    },

    save(state: PromptStoreState): Promise<void> {
      const json = JSON.stringify(state);
      writeChain = writeChain.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmpPath, json, "utf8");
        await rename(tmpPath, path);
      });
      return writeChain;
    },
  };
}
