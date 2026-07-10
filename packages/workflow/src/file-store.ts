import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type {
  WorkflowRunFilter,
  WorkflowRunRecord,
  WorkflowResumeClaim,
  WorkflowRunStore,
} from "./registry.js";
import { runStatusOf, WorkflowResumeConflictError } from "./registry.js";

// ─── fileWorkflowRunStore() ───────────────────────────────────────────────────
//
// A crash-safe, single-file JSON store for workflow run records.
//
// Design — why a snapshot-with-atomic-rename rather than JSON-lines append:
//   The registry updates records IN PLACE (a suspended run transitions to
//   completed/error on resume), so an append-only log would need compaction and
//   last-write-wins replay on load. A full-snapshot rewrite keeps the
//   implementation tiny and correct: each `save()` writes the entire record set
//   to a random owner-only temp file, then `rename()`s it over the target. POSIX `rename` is
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
 * Crash-safety: each write is fsynced to a random owner-only temp file and atomically
 * `rename`d over `path`, then the directory is fsynced. An owner-only cross-process lock
 * serializes snapshot read-modify-write operations. Caller-writable symlink leaves and parent
 * components are refused; missing parent directories are created one component at a time.
 *
 * @param path — absolute or relative path to the JSON file.
 */
export function fileWorkflowRunStore(path: string): WorkflowRunStore {
  // Resolve once. A later process.chdir() must not redirect an already-created
  // store to a different persistence boundary.
  const filePath = resolve(path);
  // In-memory mirror, lazily loaded from disk. Insertion order is preserved by
  // the array; the map gives O(1) id lookup.
  let loaded = false;
  const order: string[] = [];
  const byId = new Map<string, WorkflowRunRecord>();

  // Serialize all disk writes through this chain.
  let writeChain: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const operation = writeChain.catch(() => undefined).then(fn);
    writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function diskSnapshot(): Promise<WorkflowRunRecord[]> {
    try {
      const raw = await readPrivateFile(filePath);
      const parsed = JSON.parse(raw) as WorkflowRunRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  function replaceMirror(records: WorkflowRunRecord[]): void {
    order.length = 0;
    byId.clear();
    for (const record of records) {
      if (!record || typeof record.id !== "string" || byId.has(record.id)) continue;
      byId.set(record.id, record);
      order.push(record.id);
    }
    loaded = true;
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    try {
      const raw = await readPrivateFile(filePath);
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

  return {
    async save(record: WorkflowRunRecord): Promise<void> {
      await enqueue(() => withExclusiveFileLock(filePath, async () => {
        const records = await diskSnapshot();
        const index = records.findIndex((candidate) => candidate.id === record.id);
        if (index >= 0) records[index] = record;
        else records.push(record);
        await atomicWritePrivateFile(filePath, JSON.stringify(records));
        replaceMirror(records);
      }));
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
      await enqueue(() => withExclusiveFileLock(filePath, async () => {
        const records = await diskSnapshot();
        const filtered = records.filter((record) => record.id !== id);
        if (filtered.length === records.length) {
          replaceMirror(records);
          return;
        }
        await atomicWritePrivateFile(filePath, JSON.stringify(filtered));
        replaceMirror(filtered);
      }));
    },

    async claimResume(id: string, expectedToken: string, claim: WorkflowResumeClaim): Promise<WorkflowRunRecord> {
      return enqueue(() => withExclusiveFileLock(filePath, async () => {
        const records = await diskSnapshot();
        const index = records.findIndex((record) => record.id === id);
        if (index < 0) throw new WorkflowResumeConflictError(id, "is unknown");
        const current = records[index]!;
        const reclaimable = current.runStatus === "resuming" &&
          current.resumeClaim !== undefined && current.resumeClaim.expiresAt <= claim.claimedAt;
        if ((!reclaimable && runStatusOf(current) !== "suspended") || current.suspension?.token !== expectedToken) {
          throw new WorkflowResumeConflictError(id);
        }
        const claimed: WorkflowRunRecord = { ...current, runStatus: "resuming", resumeClaim: { ...claim } };
        records[index] = claimed;
        await atomicWritePrivateFile(filePath, JSON.stringify(records));
        replaceMirror(records);
        return claimed;
      }));
    },

    async finishResume(id: string, claimId: string, record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
      return enqueue(() => withExclusiveFileLock(filePath, async () => {
        const records = await diskSnapshot();
        const index = records.findIndex((candidate) => candidate.id === id);
        const current = index >= 0 ? records[index] : undefined;
        if (!current || current.runStatus !== "resuming" || current.resumeClaim?.id !== claimId) {
          throw new WorkflowResumeConflictError(id, "does not belong to this resume claim");
        }
        const finished = { ...record };
        delete finished.resumeClaim;
        records[index] = finished;
        await atomicWritePrivateFile(filePath, JSON.stringify(records));
        replaceMirror(records);
        return finished;
      }));
    },
  };
}

async function withExclusiveFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const parent = await ensureSafeParentDirectory(path);
  const lockPath = join(parent, `.${basename(path)}.lock`);
  const deadline = Date.now() + 5_000;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  const token = randomUUID();

  while (!lock) {
    try {
      const candidate = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let candidateIdentity: { dev: number; ino: number } | undefined;
      try {
        const candidateStat = await candidate.stat();
        candidateIdentity = { dev: candidateStat.dev, ino: candidateStat.ino };
        await candidate.writeFile(
          JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }),
          "utf8",
        );
        await candidate.chmod(0o600);
        await candidate.sync();
        lockIdentity = candidateIdentity;
        lock = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        if (candidateIdentity !== undefined) {
          await unlinkMatchingFile(lockPath, candidateIdentity).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertSafeParentDirectory(path);
      const entry = await lstat(lockPath).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error(`fileWorkflowRunStore: refusing symlink lock: ${lockPath}`);
      if (entry !== undefined && !entry.isFile()) {
        throw new Error(`fileWorkflowRunStore: lock path is not a regular file: ${lockPath}`);
      }
      if (entry && await removeDeadStaleLock(lockPath, entry)) {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`fileWorkflowRunStore: timed out acquiring file lock for ${path}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  try {
    await assertSafeParentDirectory(path);
    return await fn();
  } finally {
    await lock.close().catch(() => undefined);
    if (lockIdentity !== undefined) {
      await unlinkOwnedLock(lockPath, lockIdentity, token);
    }
  }
}

async function readPrivateFile(path: string): Promise<string> {
  await assertSafeParentDirectory(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`fileWorkflowRunStore: refusing symlink path: ${path}`);
    }
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error(`fileWorkflowRunStore: path is not a regular file: ${path}`);
    if ((entry.mode & 0o777) !== 0o600) {
      await handle.chmod(0o600);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateFile(path: string, data: string): Promise<void> {
  const parent = await ensureSafeParentDirectory(path);
  await rejectSymlinkLeaf(path, "fileWorkflowRunStore");
  const temp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temp, flags, 0o600);
    await handle.writeFile(data, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeParentDirectory(path);
    await rejectSymlinkLeaf(path, "fileWorkflowRunStore");
    await rename(temp, path);
    renamed = true;
    try {
      const dirHandle = await open(
        parent,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { /* directory fsync is unavailable on some filesystems */ }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

async function rejectSymlinkLeaf(path: string, label: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`${label}: refusing symlink path: ${path}`);
    if (!entry.isFile()) throw new Error(`${label}: path is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function ensureSafeParentDirectory(path: string): Promise<string> {
  return walkSafeParentDirectory(path, true);
}

async function assertSafeParentDirectory(path: string): Promise<string> {
  return walkSafeParentDirectory(path, false);
}

/**
 * Walk every parent component without recursive mkdir (which follows links).
 * Symlinks below a caller-writable directory fail closed. Platform-managed
 * aliases such as macOS `/var -> /private/var` remain usable because their
 * parent is not writable by the current process.
 */
async function walkSafeParentDirectory(path: string, createMissing: boolean): Promise<string> {
  const parent = resolve(dirname(path));
  const root = parse(parent).root;
  let current = root;
  let parentEntry: Stats = await stat(root);
  const parts = parent.slice(root.length).split(sep).filter(Boolean);

  for (const part of parts) {
    current = join(current, part);
    let entry: Stats;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createMissing) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      entry = await lstat(current);
    }

    if (entry.isSymbolicLink()) {
      if (isDirectoryWritableByCurrentProcess(parentEntry)) {
        throw new Error(`fileWorkflowRunStore: refusing symlink parent: ${current}`);
      }
      const target = await stat(current);
      if (!target.isDirectory()) {
        throw new Error(`fileWorkflowRunStore: parent symlink is not a directory: ${current}`);
      }
      parentEntry = target;
      continue;
    }
    if (!entry.isDirectory()) {
      throw new Error(`fileWorkflowRunStore: parent path is not a directory: ${current}`);
    }
    parentEntry = entry;
  }
  return parent;
}

function isDirectoryWritableByCurrentProcess(entry: Stats): boolean {
  const mode = entry.mode;
  if ((mode & 0o002) !== 0) return true;
  const getUid = process.getuid;
  if (typeof getUid !== "function") return (mode & 0o020) !== 0;
  const uid = getUid.call(process);
  if (uid === 0 || (entry.uid === uid && (mode & 0o200) !== 0)) return true;
  const groups = typeof process.getgroups === "function" ? process.getgroups() : [];
  return groups.includes(entry.gid) && (mode & 0o020) !== 0;
}

async function removeDeadStaleLock(
  lockPath: string,
  observed: Stats,
): Promise<boolean> {
  if (Date.now() - observed.mtimeMs <= 30_000 || !observed.isFile()) return false;
  let pid: number | undefined;
  let rawMetadata: string;
  try {
    rawMetadata = await readPrivateFile(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const metadata = JSON.parse(rawMetadata) as { pid?: unknown };
    if (Number.isSafeInteger(metadata.pid) && (metadata.pid as number) > 0) {
      pid = metadata.pid as number;
    }
  } catch {
    // A malformed, old regular lock has no live owner identity and may be reaped.
  }
  if (pid !== undefined && processIsAlive(pid)) return false;

  // Re-check the inode immediately before unlinking so a replaced lock is not
  // mistaken for the stale file that was originally inspected.
  const current = await lstat(lockPath).catch(() => undefined);
  if (current === undefined) return true;
  if (current.isSymbolicLink()) {
    throw new Error(`fileWorkflowRunStore: refusing symlink lock: ${lockPath}`);
  }
  if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
  await unlink(lockPath);
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function unlinkOwnedLock(
  lockPath: string,
  identity: { dev: number; ino: number },
  token: string,
): Promise<void> {
  const current = await lstat(lockPath).catch(() => undefined);
  if (current === undefined) return;
  if (current.isSymbolicLink()) {
    throw new Error(`fileWorkflowRunStore: refusing symlink lock: ${lockPath}`);
  }
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  let rawMetadata: string;
  try {
    rawMetadata = await readPrivateFile(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const metadata = JSON.parse(rawMetadata) as { token?: unknown };
    if (metadata.token !== token) return;
  } catch {
    return;
  }
  await unlinkMatchingFile(lockPath, identity);
}

async function unlinkMatchingFile(
  path: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current === undefined) return;
  if (current.isSymbolicLink()) {
    throw new Error(`fileWorkflowRunStore: refusing symlink path: ${path}`);
  }
  if (current.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path);
  }
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
