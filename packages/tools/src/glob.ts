import { opendir } from "node:fs/promises";
import { join, sep } from "node:path";

/** Hard cap on pattern and path lengths to prevent algorithmic DoS. */
const MAX_PATTERN_LEN = 1024;
const MAX_PATH_LEN = 4096;

/**
 * Match a single path SEGMENT (no `/`) against a segment PATTERN using a
 * linear two-pointer O(n·m) algorithm. Supports `*` (zero or more non-`/`
 * chars) and `?` (exactly one char). No backtracking regex is used.
 */
function matchSegment(pattern: string, text: string): boolean {
  // Two-pointer iterative star-index technique.
  let pi = 0; // pattern index
  let ti = 0; // text index
  let starPi = -1; // last `*` position in pattern
  let matchTi = -1; // text index when last `*` was matched

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === text[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starPi = pi;
      matchTi = ti;
      pi++; // try matching `*` against zero chars first
    } else if (starPi !== -1) {
      // backtrack: let the last `*` consume one more char
      pi = starPi + 1;
      matchTi++;
      ti = matchTi;
    } else {
      return false;
    }
  }

  // Consume any trailing `*`s in the pattern
  while (pi < pattern.length && pattern[pi] === "*") pi++;

  return pi === pattern.length;
}

/**
 * Match a `/`-separated path against a `/`-separated glob pattern using
 * a linear two-pointer O(n·m) algorithm on SEGMENTS.
 *
 * - `*`  — any run of non-`/` chars within a segment
 * - `**` — zero or more whole path segments
 * - `?`  — one non-`/` char within a segment
 *
 * Replaces the old `globToRegExp` which compiled agent-controlled patterns
 * into regexes, enabling catastrophic backtracking (ReDoS).
 */
export function matchGlobPattern(pattern: string, path: string): boolean {
  const pSegs = pattern.split("/");
  const tSegs = path.split("/");

  // Two-pointer technique over segment arrays, where `**` matches any
  // slice of segment list (including the empty slice).
  let pi = 0; // pattern segment index
  let ti = 0; // path segment index
  let starPi = -1; // last `**` position in pSegs
  let matchTi = -1; // path segment index when last `**` was recorded

  while (ti < tSegs.length) {
    if (pi < pSegs.length && pSegs[pi] === "**") {
      starPi = pi;
      matchTi = ti;
      pi++; // try consuming zero segments
    } else if (pi < pSegs.length && matchSegment(pSegs[pi]!, tSegs[ti]!)) {
      pi++;
      ti++;
    } else if (starPi !== -1) {
      // Let the last `**` consume one more segment
      pi = starPi + 1;
      matchTi++;
      ti = matchTi;
    } else {
      return false;
    }
  }

  // Consume trailing `**`s
  while (pi < pSegs.length && pSegs[pi] === "**") pi++;

  return pi === pSegs.length;
}

/** Recursively list files under `root` as `/`-separated relative paths. Skips symlinked dirs (§5.6). */
export async function walkDir(root: string, sub = "", maxResults = 100_000): Promise<string[]> {
  const out: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    if (out.length >= maxResults) return;
    const dir = relativeDir ? join(root, relativeDir) : root;
    let entries;
    try {
      entries = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of entries) {
      if (out.length >= maxResults) break;
      if (entry.isSymbolicLink()) continue;
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }
  await visit(sub);
  return out;
}

/** Match relative paths under `root` against `pattern`. Returns `/`-separated relative paths, sorted. */
export async function matchGlob(root: string, pattern: string): Promise<string[]> {
  if (pattern.length > MAX_PATTERN_LEN) {
    throw new Error(`glob: pattern too long (max ${MAX_PATTERN_LEN} chars)`);
  }
  const normalizedPattern = pattern.split(sep).join("/");
  const all = await walkDir(root);
  return all
    .filter((p) => {
      if (p.length > MAX_PATH_LEN) return false;
      return matchGlobPattern(normalizedPattern, p);
    })
    .sort();
}

export { relative } from "node:path";
