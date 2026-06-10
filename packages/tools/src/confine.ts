import { realpath } from "node:fs/promises";
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
  return candidate;
}

/** Re-exported helpers used by glob/grep walks. */
export { dirname, basename, join, relative, resolve, isAbsolute };
