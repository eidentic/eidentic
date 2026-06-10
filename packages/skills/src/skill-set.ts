import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, stat, lstat, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tokenize, type SkillCatalogEntry, type SkillPort, type LoadedSkill, type SkillProvenance } from "@eidentic/types";
import { parseSkillMd, type SkillManifest } from "./parse.js";

/** One skill source: raw SKILL.md content + its provenance origin. */
export interface SkillManifestInput {
  content: string;
  source: string;     // "inline:<name>", a file path, etc.
  author?: string;
  /** Optional starting per-skill memory (e.g. an existing `.memory.md`). */
  memory?: string;
}

interface SkillRecord {
  manifest: SkillManifest;
  body: string;
  provenance: SkillProvenance;
  memory: string;          // accumulated `.memory.md` (may be "")
  memoryPath?: string;     // on-disk `.memory.md` path when dir-backed
  skillDir?: string;       // on-disk skill directory (for path-confined reads)
  references?: string[];   // relative paths of Tier-3 files (references/, scripts/, assets/)
  docTokens: Set<string>;  // precomputed search tokens: tokenize(name + " " + description)
}

export interface SkillSetOptions {
  /** Injected clock for deterministic per-skill-memory timestamps. */
  now?: () => string;
}

/** Max bytes for per-skill .memory.md before tail-truncation (Fix 4). */
const MEMORY_MAX_BYTES = 16 * 1024; // 16 KB

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Tier-3 subdirs scanned for reference/asset/script files. */
const TIER3_DIRS = ["references", "scripts", "assets"] as const;

/**
 * Enumerate one-level-deep files in a subdir (e.g. `references/`) relative to the skill dir.
 * Returns relative paths like `"references/api.md"`. Skips symlinks (Fix 3).
 */
async function enumTier3Dir(skillDir: string, subdir: string): Promise<string[]> {
  const subdirPath = join(skillDir, subdir);
  let entries: Dirent[];
  try {
    entries = await readdir(subdirPath, { withFileTypes: true });
  } catch {
    return []; // subdir absent → not an error
  }
  const paths: string[] = [];
  for (const e of entries) {
    // Fix 3: skip symlinks in Tier-3 enumeration
    if (e.isSymbolicLink()) continue;
    if (e.isFile()) {
      paths.push(`${subdir}/${e.name}`);
    }
  }
  return paths;
}

/**
 * Resolve `userPath` relative to `skillDir` and assert it stays within `skillDir`.
 * Throws with a clear message on path-escape (path-traversal, absolute paths, symlinks pointing outside).
 * Returns the resolved absolute path on success, or null if the file doesn't exist (not an escape).
 */
async function confinedResolve(skillDir: string, userPath: string): Promise<string | null> {
  if (isAbsolute(userPath)) {
    throw new Error(`skill_read: absolute paths are not allowed (got "${userPath}")`);
  }
  const candidate = resolve(skillDir, userPath);
  // Ensure the path stays within the skill dir before following symlinks.
  const rel = relative(skillDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`skill_read: path escape detected (got "${userPath}")`);
  }
  // Now resolve through symlinks and verify again (Fix 3 symlink escape).
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    // File doesn't exist — not a security issue, return null to signal "not found"
    return null;
  }
  const realRel = relative(await realpath(skillDir), real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`skill_read: symlink escape detected (got "${userPath}")`);
  }
  return real;
}

/**
 * Tail-truncate `content` so that it is at most `maxBytes` bytes (UTF-8).
 * Keeps the most recent (trailing) content. Always preserves whole lines.
 */
function tailTruncate(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return content;
  // Keep the last `maxBytes` bytes, then skip to the next newline boundary.
  const tail = buf.subarray(buf.length - maxBytes).toString("utf8");
  const nlIdx = tail.indexOf("\n");
  if (nlIdx === -1) return tail;
  return tail.slice(nlIdx + 1);
}

/**
 * In-memory + dir-backed SkillPort (§7). Pure construction path (`fromManifests`) for tests;
 * `loadFromDir` reads star/SKILL.md (+ sibling .memory.md) and computes provenance hashes.
 */
export class SkillSet implements SkillPort {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly order: string[] = [];
  private readonly now: () => string;

  private constructor(records: SkillRecord[], opts?: SkillSetOptions) {
    this.now = opts?.now ?? (() => new Date().toISOString());
    for (const r of records) {
      if (this.skills.has(r.manifest.name)) {
        throw new Error(`SkillSet: duplicate skill name "${r.manifest.name}"`);
      }
      this.skills.set(r.manifest.name, r);
      this.order.push(r.manifest.name);
    }
  }

  /** Build from in-memory SKILL.md sources (deterministic, no I/O). */
  static fromManifests(inputs: SkillManifestInput[], opts?: SkillSetOptions): SkillSet {
    const records = inputs.map((input): SkillRecord => {
      const { manifest, body } = parseSkillMd(input.content);
      const provenance: SkillProvenance = {
        source: input.source,
        contentHash: sha256(input.content),
        ...(input.author !== undefined ? { author: input.author } : {}),
      };
      const docTokens = new Set(tokenize(`${manifest.name} ${manifest.description}`));
      return { manifest, body, provenance, memory: input.memory ?? "", docTokens };
    });
    return new SkillSet(records, opts);
  }

  /**
   * Read each immediate child directory's SKILL.md under `dir`, plus any sibling .memory.md.
   * Fix 2: also enumerates references/, scripts/, assets/ subdirs for Tier-3 pointer catalog.
   * Fix 3: skips directory entries that are symlinks.
   */
  static async loadFromDir(dir: string, opts?: SkillSetOptions): Promise<SkillSet> {
    const entries = await readdir(dir, { withFileTypes: true });
    const records: SkillRecord[] = [];
    for (const e of entries) {
      // Fix 3: skip symlinked entries — a symlinked skill dir could point outside the skills root.
      if (e.isSymbolicLink()) continue;
      if (!e.isDirectory()) continue;

      const skillDir = join(dir, e.name);
      const skillMdPath = join(skillDir, "SKILL.md");

      // Fix 3: lstat SKILL.md itself to detect symlinks before reading.
      let skillMdStat: Awaited<ReturnType<typeof lstat>>;
      try {
        skillMdStat = await lstat(skillMdPath);
      } catch {
        continue; // no SKILL.md
      }
      if (skillMdStat.isSymbolicLink()) continue; // skip symlinked SKILL.md

      let content: string;
      try {
        content = await readFile(skillMdPath, "utf8");
      } catch {
        continue;
      }

      let manifest: SkillManifest;
      let body: string;
      try {
        ({ manifest, body } = parseSkillMd(content));
      } catch {
        // skip malformed skill
        continue;
      }

      const provenance: SkillProvenance = { source: skillMdPath, contentHash: sha256(content) };

      // .memory.md — Fix 3: lstat to skip symlinks
      const memoryPath = join(skillDir, ".memory.md");
      let memory = "";
      try {
        const mStat = await lstat(memoryPath);
        if (mStat.isFile() && !mStat.isSymbolicLink()) {
          memory = await readFile(memoryPath, "utf8");
        }
      } catch { /* no per-skill memory yet */ }

      // Fix 2: enumerate Tier-3 dirs (one level deep, symlinks skipped inside enumTier3Dir)
      const refPaths: string[] = [];
      for (const sub of TIER3_DIRS) {
        const found = await enumTier3Dir(skillDir, sub);
        refPaths.push(...found);
      }

      const docTokens = new Set(tokenize(`${manifest.name} ${manifest.description}`));
      records.push({
        manifest, body, provenance, memory, memoryPath, skillDir,
        references: refPaths.length > 0 ? refPaths : undefined,
        docTokens,
      });
    }
    return new SkillSet(records, opts);
  }

  catalog(): SkillCatalogEntry[] {
    return this.order.map((name) => {
      const r = this.skills.get(name)!;
      return { name: r.manifest.name, description: r.manifest.description };
    });
  }

  search(query: string, topK = 5): SkillCatalogEntry[] {
    const q = new Set(tokenize(query));
    if (q.size === 0) return [];
    const scored: Array<{ entry: SkillCatalogEntry; score: number; idx: number }> = [];
    this.order.forEach((name, idx) => {
      const r = this.skills.get(name)!;
      let overlap = 0;
      for (const t of r.docTokens) if (q.has(t)) overlap += 1;
      if (overlap > 0) {
        scored.push({ entry: { name: r.manifest.name, description: r.manifest.description }, score: overlap, idx });
      }
    });
    scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx)); // stable: insertion order tiebreak
    return scored.slice(0, topK).map((s) => s.entry);
  }

  async use(name: string): Promise<LoadedSkill | null> {
    const r = this.skills.get(name);
    if (!r) return null;
    const loaded: LoadedSkill = {
      name: r.manifest.name,
      description: r.manifest.description,
      body: r.body,
      provenance: r.provenance,
    };
    if (r.manifest.allowedTools !== undefined) loaded.allowedTools = r.manifest.allowedTools;
    const mem = r.memory.trim();
    if (mem !== "") loaded.memory = mem;
    // Fix 2: include Tier-3 pointer catalog
    if (r.references !== undefined && r.references.length > 0) loaded.references = r.references;
    return loaded;
  }

  async recordOutcome(name: string, note: string): Promise<void> {
    const r = this.skills.get(name);
    if (!r) return; // unknown skill => no-op
    const line = `- [${this.now()}] ${note}`;
    r.memory = r.memory === "" ? line + "\n" : r.memory.replace(/\n?$/, "\n") + line + "\n";
    // Fix 4: cap memory at MEMORY_MAX_BYTES, keeping newest content
    r.memory = tailTruncate(r.memory, MEMORY_MAX_BYTES);
    if (r.memoryPath) await writeFile(r.memoryPath, r.memory);
  }

  /**
   * Fix 2: Read a specific Tier-3 file for a skill by relative path.
   * Path is confined to the skill's own directory (Fix 3).
   * Additional restriction: the resolved path must start with a Tier-3 dir name (references/, scripts/, assets/).
   * Returns null for in-memory (no skillDir), file-not-found, or non-Tier-3 paths.
   * Throws on path-traversal / symlink escape attempts.
   */
  async read(name: string, path: string): Promise<string | null> {
    const r = this.skills.get(name);
    if (!r || !r.skillDir) return null;

    // confinedResolve throws on escape, returns null if file doesn't exist
    const resolvedPath = await confinedResolve(r.skillDir, path);
    if (resolvedPath === null) return null;

    // Enforce Tier-3 restriction: first segment of the relative path must be a Tier-3 dir
    // Use realpath of skillDir to properly compute relative path (handles /tmp → /private/tmp on macOS)
    const realSkillDir = await realpath(r.skillDir);
    const relPath = relative(realSkillDir, resolvedPath);
    const firstSegment = relPath.split(/[\\/]/)[0];
    if (!TIER3_DIRS.includes(firstSegment as typeof TIER3_DIRS[number])) {
      return null;
    }

    // Confirm the resolved file is a regular file (not a directory, etc.)
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(resolvedPath);
    } catch {
      return null;
    }
    if (!fileStat.isFile()) return null;

    return readFile(resolvedPath, "utf8");
  }
}
