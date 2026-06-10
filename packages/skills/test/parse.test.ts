import { describe, it, expect } from "vitest";
import { parseSkillMd } from "../src/parse.js";

const SAMPLE = `---
name: git-commit
description: |
  Use when the user wants to write a git commit message.
  Produces a Conventional Commit subject + body.
allowed-tools: [bash, read]
---
# Git Commit

Write a Conventional Commit. Subject <= 72 chars, imperative mood.
`;

describe("parseSkillMd", () => {
  it("parses name, multi-line block-scalar description, inline allowed-tools, and body", () => {
    const { manifest, body } = parseSkillMd(SAMPLE);
    expect(manifest.name).toBe("git-commit");
    expect(manifest.description).toBe(
      "Use when the user wants to write a git commit message.\nProduces a Conventional Commit subject + body.",
    );
    expect(manifest.allowedTools).toEqual(["bash", "read"]);
    expect(body).toBe(
      "# Git Commit\n\nWrite a Conventional Commit. Subject <= 72 chars, imperative mood.",
    );
  });

  it("parses a single-line description and omits allowed-tools when absent", () => {
    const { manifest } = parseSkillMd(`---
name: hello
description: A short skill.
---
Body.
`);
    expect(manifest.description).toBe("A short skill.");
    expect(manifest.allowedTools).toBeUndefined();
  });

  it("throws on missing frontmatter fences", () => {
    expect(() => parseSkillMd("# no frontmatter here")).toThrow(/frontmatter/i);
  });

  it("throws on a missing required key (name)", () => {
    expect(() => parseSkillMd(`---
description: no name
---
Body.
`)).toThrow(/name/i);
  });

  it("throws on a non-kebab-case name", () => {
    expect(() => parseSkillMd(`---
name: Not_KebabCase
description: x
---
b
`)).toThrow(/kebab/i);
  });

  it("throws on an over-long name (>64) or description (>1024)", () => {
    const longName = "a".repeat(65);
    expect(() => parseSkillMd(`---\nname: ${longName}\ndescription: x\n---\nb\n`)).toThrow(/64/);
    const longDesc = "d".repeat(1025);
    expect(() => parseSkillMd(`---\nname: ok\ndescription: ${longDesc}\n---\nb\n`)).toThrow(/1024/);
  });

  it("parses a CRLF-line-ending SKILL.md identically to its LF equivalent", () => {
    const lf = `---\nname: git-commit\ndescription: |\n  Use when the user wants to write a git commit message.\n  Produces a Conventional Commit subject + body.\nallowed-tools: [bash, read]\n---\n# Git Commit\n\nWrite a Conventional Commit. Subject <= 72 chars, imperative mood.\n`;
    const crlf = lf.replace(/\n/g, "\r\n");
    const { manifest: mLf, body: bLf } = parseSkillMd(lf);
    const { manifest: mCrlf, body: bCrlf } = parseSkillMd(crlf);
    expect(mCrlf.name).toBe(mLf.name);
    expect(mCrlf.description).toBe(mLf.description);
    expect(mCrlf.allowedTools).toEqual(mLf.allowedTools);
    expect(bCrlf).toBe(bLf);
  });

  // --- Fix 1: real YAML shape coverage ---

  it("parses YAML block-list allowed-tools (not just inline [a,b])", () => {
    const { manifest } = parseSkillMd(`---
name: db-migrate
description: Generates database migrations.
allowed-tools:
  - bash
  - read
  - write
---
Body.
`);
    expect(manifest.allowedTools).toEqual(["bash", "read", "write"]);
  });

  it("parses double-quoted name and description scalars", () => {
    const { manifest } = parseSkillMd(`---
name: "my-skill"
description: "A quoted description."
---
Body.
`);
    expect(manifest.name).toBe("my-skill");
    expect(manifest.description).toBe("A quoted description.");
  });

  it("parses single-quoted scalars", () => {
    const { manifest } = parseSkillMd(`---
name: 'my-skill'
description: 'Single quoted description.'
---
Body.
`);
    expect(manifest.name).toBe("my-skill");
    expect(manifest.description).toBe("Single quoted description.");
  });

  it("parses folded `>` description scalar", () => {
    const { manifest } = parseSkillMd(`---
name: folded-skill
description: >
  Use when you need a folded scalar description
  that spans multiple lines.
---
Body.
`);
    // YAML folded scalars collapse newlines within the block to spaces
    expect(manifest.description).toMatch(/Use when you need a folded scalar description/);
    expect(manifest.description).toBeTruthy();
  });

  it("handles inline # comments after values", () => {
    const { manifest } = parseSkillMd(`---
name: commented-skill # this is the name
description: Short description. # inline comment
---
Body.
`);
    expect(manifest.name).toBe("commented-skill");
    expect(manifest.description).toBe("Short description.");
  });

  it("preserves license, version, and arbitrary metadata fields", () => {
    const { manifest } = parseSkillMd(`---
name: rich-skill
description: A skill with extra fields.
license: MIT
version: "1.2.3"
metadata:
  author-email: dev@example.com
  tags:
    - infra
    - deploy
---
Body.
`);
    expect(manifest.license).toBe("MIT");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.metadata).toBeDefined();
    expect((manifest.metadata as Record<string, unknown>)["metadata"]).toMatchObject({
      "author-email": "dev@example.com",
      tags: ["infra", "deploy"],
    });
  });

  it("preserves unknown top-level frontmatter keys in metadata", () => {
    const { manifest } = parseSkillMd(`---
name: extra-skill
description: Has custom keys.
custom-key: some-value
another-key: 42
---
Body.
`);
    expect(manifest.metadata).toBeDefined();
    expect((manifest.metadata as Record<string, unknown>)["custom-key"]).toBe("some-value");
    expect((manifest.metadata as Record<string, unknown>)["another-key"]).toBe(42);
  });

  it("metadata is undefined when no extra keys present", () => {
    const { manifest } = parseSkillMd(`---
name: simple
description: Just the basics.
---
Body.
`);
    expect(manifest.metadata).toBeUndefined();
  });
});
