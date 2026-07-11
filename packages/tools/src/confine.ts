import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";

/**
 * Resolve `userPath` against `root` and assert it stays within `root`.
 * Mirrors @eidentic/skills `confinedResolve` EXACTLY (§5.6, §10.7):
 *  - reject absolute user paths;
 *  - lexical containment (reject `..`-escape) BEFORE touching the FS;
 *  - follow symlinks via realpath and re-check containment (symlink escape).
 *
 * Returns the resolved real absolute path, or `null` when the file does not exist
 * (ENOENT is "not found", NOT an escape). Throws on any escape attempt.
 */
export async function confinedResolve(root: string, userPath: string): Promise<string | null> {
  if (isAbsolute(userPath)) {
    throw new Error(`path-confinement: absolute paths are not allowed (got "${userPath}")`);
  }
  const candidate = resolve(root, userPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path-confinement: path escape detected (got "${userPath}")`);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return null; // does not exist — not an escape
  }
  const realRel = relative(await realpath(root), real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`path-confinement: symlink escape detected (got "${userPath}")`);
  }
  return real;
}

/**
 * Confine a WRITE target whose leaf may not yet exist: confine the PARENT directory
 * (which must exist or will be created up the chain), then re-join the leaf.
 * Returns the absolute path to write to. Throws on escape.
 *
 * Strategy: lexically contain the full candidate first; then confine the nearest
 * existing ancestor via realpath so symlinked ancestors cannot escape.
 */
export async function confineWriteTarget(root: string, userPath: string): Promise<string> {
  if (isAbsolute(userPath)) {
    throw new Error(`path-confinement: absolute paths are not allowed (got "${userPath}")`);
  }
  const candidate = resolve(root, userPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path-confinement: path escape detected (got "${userPath}")`);
  }
  // Walk up to the nearest existing ancestor and verify it is inside root via realpath.
  let ancestor = dirname(candidate);
  const realRoot = await realpath(root);
  // Climb until an existing directory is found (root always exists).
  // realpath throws on missing dirs; loop up until it resolves.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      const ar = relative(realRoot, realAncestor);
      if (ar.startsWith("..") || isAbsolute(ar)) {
        throw new Error(`path-confinement: symlink escape detected (got "${userPath}")`);
      }
      break;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("path-confinement:")) throw e;
      const parent = dirname(ancestor);
      if (parent === ancestor) break; // reached FS root without resolving — lexical check already passed
      ancestor = parent;
    }
  }
  try {
    const leaf = await lstat(candidate);
    if (leaf.isSymbolicLink()) {
      throw new Error(`path-confinement: symlink write target rejected (got "${userPath}")`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path-confinement:")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

export interface AtomicConfinedWriteOptions {
  /** Mode for a newly-created file. Default: 0600. */
  mode?: number;
  /** Preserve an existing regular file's mode. Default: true. */
  preserveMode?: boolean;
}

/**
 * Atomically replace a confined regular file without ever opening the destination symlink.
 * Random O_EXCL/O_NOFOLLOW temp files and rename make the leaf operation race-safe. Node does
 * not expose openat(2), so hostile parent-directory replacement remains an OS-level limitation;
 * parent realpaths are checked both before temp creation and immediately before rename.
 */
export async function atomicWriteConfined(
  root: string,
  userPath: string,
  content: string | Uint8Array,
  options: AtomicConfinedWriteOptions = {},
): Promise<void> {
  const target = await confineWriteTarget(root, userPath);
  const parent = dirname(target);
  const realRoot = await realpath(root);
  await ensureSafeParent(root, parent, realRoot, userPath);

  let existingMode: number | undefined;
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      throw new Error(`path-confinement: symlink write target rejected (got "${userPath}")`);
    }
    if (!existing.isFile()) {
      throw new Error(`path-confinement: write target is not a regular file (got "${userPath}")`);
    }
    existingMode = existing.mode & 0o777;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("path-confinement:")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const mode = options.preserveMode !== false && existingMode !== undefined
    ? existingMode
    : (options.mode ?? 0o600);
  const temp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;

  try {
    handle = await open(temp, flags, mode);
    const tempReal = await realpath(temp);
    assertInside(realRoot, tempReal, userPath);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-check parent and leaf after the potentially long write, immediately before commit.
    assertInside(realRoot, await realpath(parent), userPath);
    try {
      const leaf = await lstat(target);
      if (leaf.isSymbolicLink()) {
        throw new Error(`path-confinement: symlink write target rejected (got "${userPath}")`);
      }
      if (!leaf.isFile()) {
        throw new Error(`path-confinement: write target is not a regular file (got "${userPath}")`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("path-confinement:")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temp, target);
    renamed = true;

    // Best-effort directory fsync makes the rename durable on POSIX filesystems.
    try {
      const dirHandle = await open(parent, constants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch {
      // Some platforms/filesystems do not permit syncing directory descriptors.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

async function ensureSafeParent(
  root: string,
  parent: string,
  realRoot: string,
  userPath: string,
): Promise<void> {
  const relParent = relative(resolve(root), parent);
  const segments = relParent === "" ? [] : relParent.split(/[\\/]+/);
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`path-confinement: unsafe parent component (got "${userPath}")`);
    }
    assertInside(realRoot, await realpath(current), userPath);
  }
}

function assertInside(realRoot: string, realPath: string, userPath: string): void {
  const rel = relative(realRoot, realPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path-confinement: symlink escape detected (got "${userPath}")`);
  }
}

/** Re-exported helpers used by glob/grep walks. */
export { dirname, basename, join, relative, resolve, isAbsolute };
