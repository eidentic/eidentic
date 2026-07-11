import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { PromptStore, PromptStoreState } from "./types.js";

// ─── filePromptStore() ────────────────────────────────────────────────────────
//
// A crash-safe, single-file JSON store for prompt registry state.
//
// Design — atomic rename (mirrors packages/workflow/src/file-store.ts):
//   Each `save()` writes the full state snapshot to a random owner-only temp file, then
//   `rename()`s it over `path`. POSIX `rename` is atomic, so a crash mid-write
//   leaves either the old complete file or the new complete file — never a torn
//   one. Writes are serialised through an internal promise chain so concurrent
//   `save()` calls don't race on the same file.

/**
 * Create a {@link PromptStore} backed by a single JSON file at `path`.
 *
 * Crash-safety: each write is fsynced to a random owner-only temp file and atomically
 * `rename`d over `path`. Symlink leaves are refused. Parent directories are created on first write.
 *
 * @param path — absolute or relative path to the JSON file.
 */
export function filePromptStore(path: string): PromptStore {
  const filePath = resolve(path);
  let writeChain: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const operation = writeChain.catch(() => undefined).then(fn);
    writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function loadState(): Promise<PromptStoreState> {
    try {
      const raw = await readPrivateFile(filePath);
      const parsed = JSON.parse(raw) as PromptStoreState;
      if (!parsed || !Array.isArray(parsed.versions) || !Array.isArray(parsed.history) ||
          typeof parsed.tags !== "object" || parsed.tags === null) {
        throw new Error("filePromptStore: invalid state shape");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { versions: [], tags: {}, history: [] };
      }
      throw error;
    }
  }

  return {
    async load(): Promise<PromptStoreState | undefined> {
      await writeChain;
      try {
        const raw = await readPrivateFile(filePath);
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
      return enqueue(() => withExclusiveFileLock(filePath, () => atomicWritePrivateFile(filePath, json)));
    },

    transact<T>(mutator: (state: PromptStoreState) => T | Promise<T>): Promise<T> {
      return enqueue(() => withExclusiveFileLock(filePath, async () => {
        const state = await loadState();
        const result = await mutator(state);
        await atomicWritePrivateFile(filePath, JSON.stringify(state));
        return result;
      }));
    },
  };
}

async function readPrivateFile(path: string): Promise<string> {
  await assertSafeParentDirectory(path);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`filePromptStore: refusing symlink path: ${path}`);
    }
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error(`filePromptStore: path is not a regular file: ${path}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateFile(path: string, data: string): Promise<void> {
  const parent = await ensureSafeParentDirectory(path);
  await rejectSymlinkLeaf(path);
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
    await rejectSymlinkLeaf(path);
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

async function rejectSymlinkLeaf(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`filePromptStore: refusing symlink path: ${path}`);
    if (!entry.isFile()) throw new Error(`filePromptStore: path is not a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function withExclusiveFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const parent = await ensureSafeParentDirectory(path);
  const lockPath = join(parent, `.${basename(path)}.lock`);
  const deadline = Date.now() + 5_000;
  const token = randomUUID();
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let identity: { dev: number; ino: number } | undefined;

  while (!lock) {
    try {
      const candidate = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const entry = await candidate.stat();
        identity = { dev: entry.dev, ino: entry.ino };
        await candidate.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), "utf8");
        await candidate.chmod(0o600);
        await candidate.sync();
        lock = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        if (identity) await unlinkMatchingFile(lockPath, identity).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertSafeParentDirectory(path);
      const entry = await lstat(lockPath).catch(() => undefined);
      if (entry?.isSymbolicLink()) throw new Error(`filePromptStore: refusing symlink lock: ${lockPath}`);
      if (entry !== undefined && !entry.isFile()) {
        throw new Error(`filePromptStore: lock path is not a regular file: ${lockPath}`);
      }
      if (entry && await removeDeadStaleLock(lockPath, entry)) continue;
      if (Date.now() >= deadline) throw new Error(`filePromptStore: timed out acquiring file lock for ${path}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  try {
    await assertSafeParentDirectory(path);
    return await fn();
  } finally {
    await lock.close().catch(() => undefined);
    if (identity) await unlinkOwnedLock(lockPath, identity, token);
  }
}

async function ensureSafeParentDirectory(path: string): Promise<string> {
  return walkSafeParentDirectory(path, true);
}

async function assertSafeParentDirectory(path: string): Promise<string> {
  return walkSafeParentDirectory(path, false);
}

/** Walk every writable parent component without recursive mkdir, refusing link traversal. */
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
        throw new Error(`filePromptStore: refusing symlink parent: ${current}`);
      }
      const target = await stat(current);
      if (!target.isDirectory()) throw new Error(`filePromptStore: parent symlink is not a directory: ${current}`);
      parentEntry = target;
      continue;
    }
    if (!entry.isDirectory()) throw new Error(`filePromptStore: parent path is not a directory: ${current}`);
    parentEntry = entry;
  }
  return parent;
}

function isDirectoryWritableByCurrentProcess(entry: Stats): boolean {
  const mode = entry.mode;
  if ((mode & 0o002) !== 0) return true;
  if (typeof process.getuid !== "function") return (mode & 0o020) !== 0;
  const uid = process.getuid();
  if (uid === 0 || (entry.uid === uid && (mode & 0o200) !== 0)) return true;
  const groups = typeof process.getgroups === "function" ? process.getgroups() : [];
  return groups.includes(entry.gid) && (mode & 0o020) !== 0;
}

async function removeDeadStaleLock(lockPath: string, observed: Stats): Promise<boolean> {
  if (!observed.isFile() || Date.now() - observed.mtimeMs <= 30_000) return false;
  let pid: number | undefined;
  try {
    const metadata = JSON.parse(await readPrivateFile(lockPath)) as { pid?: unknown };
    if (Number.isSafeInteger(metadata.pid) && (metadata.pid as number) > 0) pid = metadata.pid as number;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
  }
  if (pid !== undefined && processIsAlive(pid)) return false;
  const current = await lstat(lockPath).catch(() => undefined);
  if (current === undefined) return true;
  if (current.isSymbolicLink()) throw new Error(`filePromptStore: refusing symlink lock: ${lockPath}`);
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
  if (current.isSymbolicLink()) throw new Error(`filePromptStore: refusing symlink lock: ${lockPath}`);
  if (current.dev !== identity.dev || current.ino !== identity.ino) return;
  try {
    const metadata = JSON.parse(await readPrivateFile(lockPath)) as { token?: unknown };
    if (metadata.token !== token) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await unlinkMatchingFile(lockPath, identity);
}

async function unlinkMatchingFile(path: string, identity: { dev: number; ino: number }): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current === undefined) return;
  if (current.isSymbolicLink()) throw new Error(`filePromptStore: refusing symlink path: ${path}`);
  if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
}
