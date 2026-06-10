/**
 * Fix 5: agentskills.io conformance fixture suite.
 *
 * These fixtures are shaped like real published SKILL.md files — every real-world
 * YAML shape is exercised: block-list allowed-tools, quoted/folded scalars, inline
 * comments, metadata/license/version, and a directory skill with references/.
 *
 * All fixtures must parse and load without loss.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parseSkillMd } from "../src/parse.js";
import { SkillSet } from "../src/skill-set.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

describe("agentskills.io conformance fixtures", () => {
  it("block-list-tools: parses block-list allowed-tools correctly", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("code-reviewer");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("code-reviewer");
    expect(loaded!.description).toMatch(/reviewing pull requests/);
    expect(loaded!.allowedTools).toEqual(["bash", "read", "write"]);
  });

  it("block-list-tools: references/ are listed in use() result", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("code-reviewer");
    expect(loaded!.references).toBeDefined();
    expect(loaded!.references).toContain("references/checklist.md");
  });

  it("block-list-tools: skill_read loads the reference file", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const content = await set.read("code-reviewer", "references/checklist.md");
    expect(content).toMatch(/Code Review Checklist/);
  });

  it("quoted-scalars: double-quoted name and description round-trip without quotes", () => {
    // parse directly for isolation
    const { manifest } = parseSkillMd(`---
name: "deploy-service"
description: "Use when deploying a microservice to Kubernetes or ECS."
allowed-tools: [bash, read]
---
Body.
`);
    expect(manifest.name).toBe("deploy-service");
    expect(manifest.description).toBe("Use when deploying a microservice to Kubernetes or ECS.");
    expect(manifest.allowedTools).toEqual(["bash", "read"]);
  });

  it("quoted-scalars: loads via loadFromDir without loss", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("deploy-service");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("deploy-service");
    expect(loaded!.description).toBe("Use when deploying a microservice to Kubernetes or ECS.");
    expect(loaded!.allowedTools).toEqual(["bash", "read"]);
  });

  it("folded-description: folded `>` scalar parsed without loss", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("db-backup");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("db-backup");
    // Folded scalar folds newlines to spaces — description must contain the key terms
    expect(loaded!.description).toMatch(/creating or restoring database backups/);
    expect(loaded!.description).toMatch(/PostgreSQL/);
    expect(loaded!.allowedTools).toEqual(["bash"]);
  });

  it("commented-values: inline # comments stripped by YAML parser", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("test-runner");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("test-runner");
    // Comments must NOT appear in the parsed description
    expect(loaded!.description).not.toContain("#");
    expect(loaded!.description).toMatch(/running the test suite/);
    expect(loaded!.allowedTools).toEqual(["bash"]);
  });

  it("rich-metadata: license/version/metadata fields preserved without loss", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const loaded = await set.use("api-generator");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("api-generator");
    expect(loaded!.allowedTools).toEqual(["bash", "write"]);

    // Parse directly to inspect manifest fields
    const { manifest } = parseSkillMd(`---
name: api-generator
description: Use when generating REST or GraphQL API clients from an OpenAPI schema.
license: MIT
version: "2.1.0"
metadata:
  author-email: tools@example.com
  tags:
    - codegen
    - openapi
  homepage: https://example.com/skills/api-generator
allowed-tools:
  - bash
  - write
---
Body.
`);
    expect(manifest.license).toBe("MIT");
    expect(manifest.version).toBe("2.1.0");
    expect(manifest.metadata).toBeDefined();
    const meta = manifest.metadata as Record<string, unknown>;
    expect(meta["metadata"]).toMatchObject({
      "author-email": "tools@example.com",
      tags: ["codegen", "openapi"],
    });
  });

  it("all fixtures load without errors", async () => {
    const set = await SkillSet.loadFromDir(FIXTURES);
    const names = set.catalog().map((c) => c.name).sort();
    // All 5 fixture skills must be present
    expect(names).toContain("code-reviewer");
    expect(names).toContain("deploy-service");
    expect(names).toContain("db-backup");
    expect(names).toContain("test-runner");
    expect(names).toContain("api-generator");
    // All must have non-empty descriptions
    for (const entry of set.catalog()) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
