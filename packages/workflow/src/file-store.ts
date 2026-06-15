import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  WorkflowRunFilter,
  WorkflowRunRecord,
  WorkflowRunStore,
} from "./registry.js";
import { runStatusOf } from "./registry.js";

// ─── fileWorkflowRunStore() ───────────────────────────────────────────────────
//
// A crash-safe, single-file JSON store for workflow run records.
//
// Design — why a snapshot-with-atomic-rename rather than JSON-lines append:
//   The registry updates records IN PLACE (a suspended run transitions to
//   completed/error on resume), so an append-only log would need compaction and
//   last-write-wins replay on load. A full-snapshot rewrite keeps the
//   implementation tiny and correct: each `save()` writes the entire record set
//   to a temp file, then `rename()`s it over the target. POSIX `rename` is
//   atomic, so a crash mid-write leaves either the old complete file or the new
//   complete file — never a torn one. This is the simplest option that survives
//   a crash, which is why it's the default shipped impl. Heavier backends
//   (sqlite, etc.) belong in separate adapter packages.
//
// Writes are serialized through an internal promise chain so concurrent
// `save()` calls don't race on the same file.

/**
 * Create a {@link WorkflowRunStore} backed by a single JSON file at `path`.
 *
 * Crash-safety: each write is a full snapshot written to `${path}.tmp` then
 * atomically `rename`d over `path`. A crash never leaves a partially-written
 * file. Parent directories are created on first write.
 *
 * @param path — absolute or relative path to the JSON file.
 */
export function fileWorkflowRunStore(path: string): WorkflowRunStore {
  const tmpPath = `${path}.tmp`;

  // In-memory mirror, lazily loaded from disk. Insertion order is preserved by
  // the array; the map gives O(1) id lookup.
  let loaded = false;
  const order: string[] = [];
  const byId = new Map<string, WorkflowRunRecord>();

  // Serialize all disk writes through this chain.
  let writeChain: Promise<void> = Promise.resolve();

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as WorkflowRunRecord[];
      if (Array.isArray(parsed)) {
        for (const rec of parsed) {
          if (rec && typeof rec.id === "string" && !byId.has(rec.id)) {
            byId.set(rec.id, rec);
            order.push(rec.id);
          }
        }
      }
    } catch (err: unknown) {
      // Missing file → empty store. Any other error (corrupt JSON) is rethrown
      // so the caller knows persistence is broken rather than silently empty.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    loaded = true;
  }

  /** Atomically snapshot the current record set to disk. */
  function flush(): Promise<void> {
    writeChain = writeChain.then(async () => {
      const snapshot = order.map((id) => byId.get(id)!).filter((r) => r !== undefined);
      const json = JSON.stringify(snapshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmpPath, json, "utf8");
      await rename(tmpPath, path);
    });
    return writeChain;
  }

  return {
    async save(record: WorkflowRunRecord): Promise<void> {
      await ensureLoaded();
      if (!byId.has(record.id)) order.push(record.id);
      byId.set(record.id, record);
      await flush();
    },

    async load(id: string): Promise<WorkflowRunRecord | undefined> {
      await ensureLoaded();
      return byId.get(id);
    },

    async list(filter?: WorkflowRunFilter): Promise<WorkflowRunRecord[]> {
      await ensureLoaded();
      const all = order.map((id) => byId.get(id)!).filter((r) => r !== undefined);
      const filtered = filter !== undefined ? all.filter((r) => matches(r, filter)) : all;
      // Sort newest-first: primary key is startedAt descending; seq descending
      // is the tiebreaker for records that share the same millisecond.
      return [...filtered].sort((a, b) => {
        const byTime = b.startedAt - a.startedAt;
        if (byTime !== 0) return byTime;
        return (b.seq ?? 0) - (a.seq ?? 0);
      });
    },

    async delete(id: string): Promise<void> {
      await ensureLoaded();
      if (!byId.has(id)) return;
      byId.delete(id);
      const idx = order.indexOf(id);
      if (idx >= 0) order.splice(idx, 1);
      await flush();
    },
  };
}

function matches(rec: WorkflowRunRecord, filter: WorkflowRunFilter): boolean {
  if (filter.version !== undefined && rec.version !== filter.version) return false;
  if (filter.runStatus !== undefined && runStatusOf(rec) !== filter.runStatus) return false;
  if (filter.owner !== undefined) {
    const o = rec.owner ?? {};
    const f = filter.owner;
    if (f.userId !== undefined && o.userId !== f.userId) return false;
    if (f.orgId !== undefined && o.orgId !== f.orgId) return false;
    if (f.apiKey !== undefined && o.apiKey !== f.apiKey) return false;
  }
  return true;
}
