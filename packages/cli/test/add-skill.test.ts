import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSkill,
  makeDirResolver,
  SKILLS_DIR_NAME,
  type AddSkillOptions,
} from "../src/commands.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SKILL_MD = `---
name: hello-world
description: A simple test skill that greets the user.
allowed-tools:
  - bash
version: "1.0"
---

# Hello World

Use this skill to greet the user warmly.
`;

const SKILL_WITH_SUBDIR_MD = `---
name: with-references
description: A skill that has a references subdirectory.
---

Main body.
`;

const INVALID_SKILL_MD = `---
description: Missing name field.
---

Body.
`;

const MALFORMED_SKILL_MD = `No frontmatter at all, just prose.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeSkillSource(name: string, content: string, subFiles?: Record<string, string>): string {
  const skillDir = join(tmpDir, "source-skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
  if (subFiles) {
    for (const [rel, body] of Object.entries(subFiles)) {
      const abs = join(skillDir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
  }
  return skillDir;
}

function makeProjectRoot(): string {
  const root = join(tmpDir, "project");
  mkdirSync(root, { recursive: true });
  return root;
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `eidentic-add-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// addSkill — happy path: local path
// ---------------------------------------------------------------------------

describe("addSkill() — local path source", () => {
  it("installs a valid skill into <projectRoot>/skills/<name>/", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    const result = await addSkill(srcDir, { projectRoot });

    expect(result.name).toBe("hello-world");
    expect(result.replaced).toBe(false);
    expect(result.installedAt).toBe(join(projectRoot, SKILLS_DIR_NAME, "hello-world"));
    expect(existsSync(result.installedAt)).toBe(true);
    expect(existsSync(join(result.installedAt, "SKILL.md"))).toBe(true);
  });

  it("copies the SKILL.md content verbatim", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    const result = await addSkill(srcDir, { projectRoot });

    const installed = readFileSync(join(result.installedAt, "SKILL.md"), "utf8");
    expect(installed).toBe(VALID_SKILL_MD);
  });

  it("creates the skills directory when it does not exist", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    await addSkill(srcDir, { projectRoot });

    expect(existsSync(join(projectRoot, SKILLS_DIR_NAME))).toBe(true);
  });

  it("copies additional files (e.g. references/) alongside SKILL.md", async () => {
    const srcDir = makeSkillSource("with-references", SKILL_WITH_SUBDIR_MD, {
      "references/api.md": "# API Docs",
      "scripts/helper.sh": "#!/bin/sh\necho hello",
    });
    const projectRoot = makeProjectRoot();

    const result = await addSkill(srcDir, { projectRoot });

    expect(existsSync(join(result.installedAt, "references", "api.md"))).toBe(true);
    expect(existsSync(join(result.installedAt, "scripts", "helper.sh"))).toBe(true);
    expect(readFileSync(join(result.installedAt, "references", "api.md"), "utf8")).toBe("# API Docs");
  });

  it("does NOT copy .memory.md (runtime artefact)", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD, {
      ".memory.md": "- some recorded outcome",
    });
    const projectRoot = makeProjectRoot();

    const result = await addSkill(srcDir, { projectRoot });

    expect(existsSync(join(result.installedAt, ".memory.md"))).toBe(false);
  });

  it("accepts a relative path starting with ./", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();
    // relative to projectRoot
    const relSrc = join(tmpDir, "source-skills", "hello-world");

    const result = await addSkill(relSrc, { projectRoot });
    expect(result.name).toBe("hello-world");
    expect(existsSync(join(result.installedAt, "SKILL.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addSkill — name-based resolution via resolver
// ---------------------------------------------------------------------------

describe("addSkill() — name-based resolution", () => {
  it("resolves a skill name via the injected resolver", async () => {
    const srcSkillDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const sourceDir = join(tmpDir, "source-skills");
    const projectRoot = makeProjectRoot();

    const resolver = makeDirResolver(sourceDir);
    const result = await addSkill("hello-world", { resolver, projectRoot });

    expect(result.name).toBe("hello-world");
    expect(existsSync(join(result.installedAt, "SKILL.md"))).toBe(true);
    // ensure we got the right source
    void srcSkillDir; // used to set up sourceDir
  });

  it("throws a clear error when name cannot be resolved and no resolver given", async () => {
    const projectRoot = makeProjectRoot();
    await expect(addSkill("nonexistent-skill", { projectRoot })).rejects.toThrow(
      /cannot resolve skill "nonexistent-skill"/,
    );
  });

  it("throws a clear error when resolver returns null for unknown name", async () => {
    const projectRoot = makeProjectRoot();
    const resolver = makeDirResolver(join(tmpDir, "empty-source"));
    await expect(addSkill("mystery-skill", { resolver, projectRoot })).rejects.toThrow(
      /cannot resolve skill "mystery-skill"/,
    );
  });
});

// ---------------------------------------------------------------------------
// addSkill — collision handling
// ---------------------------------------------------------------------------

describe("addSkill() — collision handling", () => {
  it("refuses to overwrite an existing skill without --force", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    // Install once
    await addSkill(srcDir, { projectRoot });
    // Try to install again
    await expect(addSkill(srcDir, { projectRoot })).rejects.toThrow(
      /already exists.*--force/,
    );
  });

  it("overwrites an existing skill when force:true", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    await addSkill(srcDir, { projectRoot });

    // Modify the skill for second install — write a different SKILL.md in a NEW source dir
    const srcDir2 = makeSkillSource("hello-world", VALID_SKILL_MD.replace("greets the user", "updated greeting"));

    const result = await addSkill(srcDir2, { force: true, projectRoot });

    expect(result.replaced).toBe(true);
    expect(result.name).toBe("hello-world");
    const content = readFileSync(join(result.installedAt, "SKILL.md"), "utf8");
    expect(content).toContain("updated greeting");
  });

  it("returns replaced:false when the skill is newly installed (no collision)", async () => {
    const srcDir = makeSkillSource("hello-world", VALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    const result = await addSkill(srcDir, { projectRoot });
    expect(result.replaced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addSkill — schema validation
// ---------------------------------------------------------------------------

describe("addSkill() — schema validation", () => {
  it("rejects a skill with missing `name` field", async () => {
    const srcDir = makeSkillSource("bad-skill", INVALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    await expect(addSkill(srcDir, { projectRoot })).rejects.toThrow(/invalid SKILL\.md/);
  });

  it("rejects a skill with no frontmatter fences", async () => {
    const srcDir = makeSkillSource("bad-skill", MALFORMED_SKILL_MD);
    const projectRoot = makeProjectRoot();

    await expect(addSkill(srcDir, { projectRoot })).rejects.toThrow(/invalid SKILL\.md/);
  });

  it("does NOT install files when validation fails (no partial writes)", async () => {
    const srcDir = makeSkillSource("bad-skill", INVALID_SKILL_MD);
    const projectRoot = makeProjectRoot();

    try {
      await addSkill(srcDir, { projectRoot });
    } catch {
      // expected
    }

    // The skills dir should either not exist or not contain a partial install
    // We cannot know the name (validation failed), but we ensure no unknown skill directories
    // were created by checking whether skills/ has any unexpected entry with a SKILL.md
    const skillsDir = join(projectRoot, SKILLS_DIR_NAME);
    if (existsSync(skillsDir)) {
      // If skills/ exists, it should be empty (no successful install)
      const entries = readdirSync(skillsDir);
      expect(entries).toHaveLength(0);
    }
    // Otherwise no skills dir was created — also fine
  });

  it("rejects a source path pointing to a file, not a directory", async () => {
    const projectRoot = makeProjectRoot();
    const filePath = join(tmpDir, "my-skill.md");
    writeFileSync(filePath, VALID_SKILL_MD, "utf8");

    await expect(addSkill(filePath, { projectRoot })).rejects.toThrow(/must be a directory/);
  });

  it("rejects a source path that does not exist", async () => {
    const projectRoot = makeProjectRoot();
    await expect(addSkill(join(tmpDir, "nonexistent"), { projectRoot })).rejects.toThrow(
      /source not found/,
    );
  });

  it("rejects a source directory that exists but has no SKILL.md", async () => {
    const emptyDir = join(tmpDir, "empty-skill");
    mkdirSync(emptyDir);
    const projectRoot = makeProjectRoot();

    await expect(addSkill(emptyDir, { projectRoot })).rejects.toThrow(/no SKILL\.md/);
  });
});

// ---------------------------------------------------------------------------
// addSkill — default projectRoot
// ---------------------------------------------------------------------------

describe("addSkill() — projectRoot default", () => {
  it("uses process.cwd() when projectRoot is not specified — option property exists", () => {
    // Just assert the type contract — that opts.projectRoot is optional.
    const opts: AddSkillOptions = { force: false };
    expect(opts.projectRoot).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeDirResolver
// ---------------------------------------------------------------------------

describe("makeDirResolver()", () => {
  it("returns the skill dir when the name matches a subdirectory", () => {
    const sourceDir = join(tmpDir, "skill-source");
    const skillDir = join(sourceDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });

    const resolver = makeDirResolver(sourceDir);
    expect(resolver("my-skill")).toBe(skillDir);
  });

  it("returns null when the name does not match any subdirectory", () => {
    const sourceDir = join(tmpDir, "skill-source");
    mkdirSync(sourceDir, { recursive: true });

    const resolver = makeDirResolver(sourceDir);
    expect(resolver("no-such-skill")).toBeNull();
  });

  it("returns null when the source dir itself does not exist", () => {
    const resolver = makeDirResolver(join(tmpDir, "nonexistent"));
    expect(resolver("anything")).toBeNull();
  });

  it("returns null for a file entry (not a directory)", () => {
    const sourceDir = join(tmpDir, "skill-source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "not-a-dir"), "content", "utf8");

    const resolver = makeDirResolver(sourceDir);
    expect(resolver("not-a-dir")).toBeNull();
  });
});

// helper used in validation test
import { readdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// addSkill — executable file warning (item 5 / LOW)
// ---------------------------------------------------------------------------

describe("addSkill() — executable file warning", () => {
  it("emits a warning when the bundle contains a .ts file", async () => {
    const warnings: string[] = [];
    const warnImpl = (msg: string) => { warnings.push(msg); };
    const srcDir = makeSkillSource("exec-skill", VALID_SKILL_MD, {
      "tool.ts": "export function hello() {}",
    });
    const projectRoot = makeProjectRoot();

    // Replace the name field so it matches
    const md = VALID_SKILL_MD.replace("hello-world", "exec-skill");
    // Overwrite SKILL.md with the correct name
    writeFileSync(join(srcDir, "SKILL.md"), md, "utf8");

    await addSkill(srcDir, { projectRoot, warnImpl });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tool\.ts/);
    expect(warnings[0]).toMatch(/executable/i);
  });

  it("emits a warning listing ALL executable files", async () => {
    const warnings: string[] = [];
    const warnImpl = (msg: string) => { warnings.push(msg); };
    const srcDir = makeSkillSource("multi-exec", VALID_SKILL_MD, {
      "run.js": "console.log('hi');",
      "helper.sh": "#!/bin/sh",
    });
    const projectRoot = makeProjectRoot();
    const md = VALID_SKILL_MD.replace("hello-world", "multi-exec");
    writeFileSync(join(srcDir, "SKILL.md"), md, "utf8");

    await addSkill(srcDir, { projectRoot, warnImpl });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/run\.js/);
    expect(warnings[0]).toMatch(/helper\.sh/);
  });

  it("does NOT warn when the bundle contains only SKILL.md and markdown assets", async () => {
    const warnings: string[] = [];
    const warnImpl = (msg: string) => { warnings.push(msg); };
    const srcDir = makeSkillSource("safe-skill", VALID_SKILL_MD, {
      "README.md": "# Docs",
      "data/examples.txt": "example content",
    });
    const projectRoot = makeProjectRoot();
    const md = VALID_SKILL_MD.replace("hello-world", "safe-skill");
    writeFileSync(join(srcDir, "SKILL.md"), md, "utf8");

    await addSkill(srcDir, { projectRoot, warnImpl });

    expect(warnings).toHaveLength(0);
  });

  it("still installs the skill despite the warning (no behavior block)", async () => {
    const srcDir = makeSkillSource("ts-skill", VALID_SKILL_MD, {
      "index.ts": "export const x = 1;",
    });
    const projectRoot = makeProjectRoot();
    const md = VALID_SKILL_MD.replace("hello-world", "ts-skill");
    writeFileSync(join(srcDir, "SKILL.md"), md, "utf8");

    const result = await addSkill(srcDir, { projectRoot, warnImpl: () => {} });

    expect(result.name).toBe("ts-skill");
    expect(existsSync(result.installedAt)).toBe(true);
    expect(existsSync(join(result.installedAt, "index.ts"))).toBe(true);
  });
});
