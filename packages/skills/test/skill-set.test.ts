import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillSet } from "../src/skill-set.js";

const GIT_COMMIT = `---
name: git-commit
description: |
  Use when the user wants to write a git commit message.
allowed-tools: [bash, read]
---
# Git Commit

Write a Conventional Commit.
`;

const DB_MIGRATION = `---
name: db-migration
description: Use when generating database migrations from a schema change.
---
# DB Migration

Generate a migration.
`;

describe("SkillSet.fromManifests (in-memory)", () => {
  it("catalog() returns name+description for every skill", () => {
    const set = SkillSet.fromManifests([
      { content: GIT_COMMIT, source: "inline:git-commit" },
      { content: DB_MIGRATION, source: "inline:db-migration" },
    ]);
    expect(set.catalog()).toEqual([
      { name: "git-commit", description: "Use when the user wants to write a git commit message." },
      { name: "db-migration", description: "Use when generating database migrations from a schema change." },
    ]);
  });

  it("search() ranks by token overlap against name+description, respects topK", () => {
    const set = SkillSet.fromManifests([
      { content: GIT_COMMIT, source: "a" },
      { content: DB_MIGRATION, source: "b" },
    ]);
    const hits = set.search("write a git commit", 5);
    expect(hits[0]?.name).toBe("git-commit");
    expect(set.search("database migration schema")[0]?.name).toBe("db-migration");
    expect(set.search("git commit", 1)).toHaveLength(1);
    expect(set.search("nothing-matches-here")).toEqual([]); // zero overlap => empty
  });

  it("use() returns body + provenance; null for unknown", async () => {
    const set = SkillSet.fromManifests([{ content: GIT_COMMIT, source: "inline:git-commit", author: "baran" }]);
    const loaded = await set.use("git-commit");
    expect(loaded?.body).toBe("# Git Commit\n\nWrite a Conventional Commit.");
    expect(loaded?.allowedTools).toEqual(["bash", "read"]);
    expect(loaded?.provenance?.source).toBe("inline:git-commit");
    expect(loaded?.provenance?.author).toBe("baran");
    expect(loaded?.provenance?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await set.use("missing")).toBeNull();
  });

  it("recordOutcome() appends a timestamped line surfaced on the next use()", async () => {
    const set = SkillSet.fromManifests([{ content: GIT_COMMIT, source: "a" }], { now: () => "2026-06-06T00:00:00.000Z" });
    expect((await set.use("git-commit"))?.memory).toBeUndefined();
    await set.recordOutcome("git-commit", "scope subjects under 72 chars");
    const loaded = await set.use("git-commit");
    expect(loaded?.memory).toContain("2026-06-06T00:00:00.000Z");
    expect(loaded?.memory).toContain("scope subjects under 72 chars");
  });

  it("recordOutcome() on an unknown skill is a no-op (does not throw)", async () => {
    const set = SkillSet.fromManifests([{ content: GIT_COMMIT, source: "a" }]);
    await expect(set.recordOutcome("missing", "x")).resolves.toBeUndefined();
  });

  it("throws on duplicate skill names", () => {
    expect(() => SkillSet.fromManifests([
      { content: GIT_COMMIT, source: "a" },
      { content: GIT_COMMIT, source: "b" },
    ])).toThrow(/duplicate/i);
  });

  it("read() returns null for in-memory SkillSet (no skillDir)", async () => {
    const set = SkillSet.fromManifests([{ content: GIT_COMMIT, source: "a" }]);
    const result = await set.read("git-commit", "references/api.md");
    expect(result).toBeNull();
  });
});

describe("SkillSet.loadFromDir (disk-backed)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eidentic-skills-"));
    await mkdir(join(dir, "git-commit"), { recursive: true });
    await writeFile(join(dir, "git-commit", "SKILL.md"), GIT_COMMIT);
    await mkdir(join(dir, "db-migration"), { recursive: true });
    await writeFile(join(dir, "db-migration", "SKILL.md"), DB_MIGRATION);
    // pre-existing per-skill memory for git-commit
    await writeFile(join(dir, "git-commit", ".memory.md"), "- prior lesson\n");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("loads each */SKILL.md, computes provenance, and reads sibling .memory.md", async () => {
    const set = await SkillSet.loadFromDir(dir, { now: () => "2026-06-06T00:00:00.000Z" });
    expect(set.catalog().map((c) => c.name).sort()).toEqual(["db-migration", "git-commit"]);
    const loaded = await set.use("git-commit");
    expect(loaded?.provenance?.source).toBe(join(dir, "git-commit", "SKILL.md"));
    expect(loaded?.memory).toContain("prior lesson");
  });

  it("recordOutcome() appends to the on-disk .memory.md when dir-backed", async () => {
    const set = await SkillSet.loadFromDir(dir, { now: () => "2026-06-06T00:00:00.000Z" });
    await set.recordOutcome("db-migration", "always wrap in a transaction");
    const onDisk = await readFile(join(dir, "db-migration", ".memory.md"), "utf8");
    expect(onDisk).toContain("always wrap in a transaction");
    expect(onDisk).toContain("2026-06-06T00:00:00.000Z");
  });

  it("skips a malformed SKILL.md and still loads the valid skills", async () => {
    // Add a third subdirectory with a broken SKILL.md (missing name field)
    await mkdir(join(dir, "broken-skill"), { recursive: true });
    await writeFile(join(dir, "broken-skill", "SKILL.md"), "this is not valid frontmatter at all");
    const set = await SkillSet.loadFromDir(dir);
    const names = set.catalog().map((c) => c.name).sort();
    expect(names).toEqual(["db-migration", "git-commit"]);
  });

  // Fix 2: Tier-3 references enumeration
  it("enumerates references/ files and includes them in use() result", async () => {
    await mkdir(join(dir, "git-commit", "references"), { recursive: true });
    await writeFile(join(dir, "git-commit", "references", "api.md"), "# API Reference\n");
    await writeFile(join(dir, "git-commit", "references", "guide.md"), "# Guide\n");
    const set = await SkillSet.loadFromDir(dir);
    const loaded = await set.use("git-commit");
    expect(loaded?.references).toBeDefined();
    expect(loaded?.references).toContain("references/api.md");
    expect(loaded?.references).toContain("references/guide.md");
  });

  it("enumerates scripts/ and assets/ alongside references/", async () => {
    await mkdir(join(dir, "db-migration", "scripts"), { recursive: true });
    await mkdir(join(dir, "db-migration", "assets"), { recursive: true });
    await writeFile(join(dir, "db-migration", "scripts", "run.py"), "print('hello')");
    await writeFile(join(dir, "db-migration", "assets", "template.sql"), "SELECT 1;");
    const set = await SkillSet.loadFromDir(dir);
    const loaded = await set.use("db-migration");
    expect(loaded?.references).toContain("scripts/run.py");
    expect(loaded?.references).toContain("assets/template.sql");
  });

  it("references is undefined when no Tier-3 files exist", async () => {
    const set = await SkillSet.loadFromDir(dir);
    const loaded = await set.use("db-migration");
    expect(loaded?.references).toBeUndefined();
  });

  // Fix 2: skill_read with path confinement
  it("read() returns the content of a references/ file", async () => {
    await mkdir(join(dir, "git-commit", "references"), { recursive: true });
    await writeFile(join(dir, "git-commit", "references", "api.md"), "# API\n");
    const set = await SkillSet.loadFromDir(dir);
    const content = await set.read("git-commit", "references/api.md");
    expect(content).toBe("# API\n");
  });

  // Tier-3 restriction: reject reads of files outside Tier-3 dirs
  it("read() returns null when trying to read SKILL.md (not in a Tier-3 dir)", async () => {
    const set = await SkillSet.loadFromDir(dir);
    const content = await set.read("git-commit", "SKILL.md");
    expect(content).toBeNull();
  });

  it("read() returns null when trying to read .memory.md (not in a Tier-3 dir)", async () => {
    const set = await SkillSet.loadFromDir(dir);
    const content = await set.read("git-commit", ".memory.md");
    expect(content).toBeNull();
  });

  it("read() returns null for a non-existent file path", async () => {
    const set = await SkillSet.loadFromDir(dir);
    const content = await set.read("git-commit", "references/nonexistent.md");
    expect(content).toBeNull();
  });

  it("read() returns null for an unknown skill name", async () => {
    const set = await SkillSet.loadFromDir(dir);
    const content = await set.read("no-such-skill", "references/api.md");
    expect(content).toBeNull();
  });

  // Fix 3: path traversal rejection
  it("read() rejects path traversal with .. segments", async () => {
    const set = await SkillSet.loadFromDir(dir);
    await expect(set.read("git-commit", "../../etc/passwd")).rejects.toThrow(/escape|traversal|absolute/i);
  });

  it("read() rejects absolute paths", async () => {
    const set = await SkillSet.loadFromDir(dir);
    await expect(set.read("git-commit", "/etc/passwd")).rejects.toThrow(/absolute/i);
  });

  // Fix 3: symlink guard in loadFromDir
  it("skips a skill directory that is itself a symlink", async () => {
    // Create a real skill in a separate dir, then symlink it in
    const realSkillDir = await mkdtemp(join(tmpdir(), "eidentic-real-skill-"));
    await writeFile(join(realSkillDir, "SKILL.md"), `---
name: symlinked-skill
description: Should not be loaded.
---
Body.
`);
    try {
      await symlink(realSkillDir, join(dir, "symlinked-skill"));
      const set = await SkillSet.loadFromDir(dir);
      const names = set.catalog().map((c) => c.name);
      expect(names).not.toContain("symlinked-skill");
    } finally {
      await rm(realSkillDir, { recursive: true, force: true });
    }
  });

  it("skips a SKILL.md that is itself a symlink", async () => {
    // Create a real SKILL.md file elsewhere, then symlink it as a skill's SKILL.md
    const externalFile = join(tmpdir(), `eidentic-external-${Date.now()}.md`);
    await writeFile(externalFile, `---
name: symlinked-content
description: Should not be loaded either.
---
Body.
`);
    await mkdir(join(dir, "symlinked-md"), { recursive: true });
    try {
      await symlink(externalFile, join(dir, "symlinked-md", "SKILL.md"));
      const set = await SkillSet.loadFromDir(dir);
      const names = set.catalog().map((c) => c.name);
      expect(names).not.toContain("symlinked-content");
    } finally {
      // cleanup external file (the dir entry will be cleaned up by afterEach)
      try { await rm(externalFile, { force: true }); } catch { /* ok */ }
    }
  });

  // Fix 4: memory cap
  it("recordOutcome() keeps memory under the 16 KB cap and retains the most recent entries", async () => {
    const set = await SkillSet.fromManifests([{ content: GIT_COMMIT, source: "a" }]);
    // Write enough entries to exceed 16 KB. Each entry is ~60 bytes; 400 entries ~ 24 KB.
    const iterations = 400;
    for (let i = 0; i < iterations; i++) {
      await set.recordOutcome("git-commit", `outcome number ${i} — padding to fill memory buffer up`);
    }
    const loaded = await set.use("git-commit");
    const mem = loaded?.memory ?? "";
    // Must be under 16 KB
    expect(Buffer.byteLength(mem, "utf8")).toBeLessThanOrEqual(16 * 1024);
    // Must retain the most recent entry
    expect(mem).toContain(`outcome number ${iterations - 1}`);
  });
});
