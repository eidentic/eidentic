import { describe, it, expect } from "vitest";
import { SkillSet } from "@eidentic/skills";
import { skillTools, hasSkills } from "../src/skill-tools.js";

const GIT_COMMIT = `---
name: git-commit
description: Use when the user wants to write a git commit message.
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

const makeSet = () => SkillSet.fromManifests([
  { content: GIT_COMMIT, source: "a" },
  { content: DB_MIGRATION, source: "b" },
]);

const byId = (tools: ReturnType<typeof skillTools>, id: string) => {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe("hasSkills", () => {
  it("is true for a SkillPort, false otherwise", () => {
    expect(hasSkills(makeSet())).toBe(true);
    expect(hasSkills({})).toBe(false);
    expect(hasSkills({ catalog: () => [], search: () => [] })).toBe(false); // missing use/recordOutcome
    expect(hasSkills(undefined)).toBe(false);
  });
});

describe("skillTools", () => {
  it("exposes skill_search, skill_use, and skill_read (when SkillPort.read is present), all read-only", () => {
    const tools = skillTools(makeSet());
    // SkillSet.fromManifests implements read() (returns null for in-memory), so skill_read is included
    expect(tools.map((t) => t.id).sort()).toEqual(["skill_read", "skill_search", "skill_use"]);
    expect(byId(tools, "skill_search").sideEffect).toBe("read-only");
    expect(byId(tools, "skill_use").sideEffect).toBe("read-only");
    expect(byId(tools, "skill_read").sideEffect).toBe("read-only");
  });

  it("does not expose skill_read when SkillPort.read is absent", () => {
    // Minimal SkillPort without read()
    const minimalPort = {
      catalog: () => [],
      search: () => [],
      use: async () => null,
      recordOutcome: async () => { /* no-op */ },
    };
    const tools = skillTools(minimalPort);
    expect(tools.map((t) => t.id).sort()).toEqual(["skill_search", "skill_use"]);
  });

  it("skill_search returns compact catalog matches ranked by description", async () => {
    const search = byId(skillTools(makeSet()), "skill_search");
    const out = (await search.execute({ query: "write a git commit" })) as { matches: Array<{ name: string; description: string }> };
    expect(out.matches[0]?.name).toBe("git-commit");
    const top1 = (await search.execute({ query: "git commit", topK: 1 })) as { matches: unknown[] };
    expect(top1.matches).toHaveLength(1);
  });

  it("skill_use returns {name, body, memory?} for a known skill", async () => {
    const use = byId(skillTools(makeSet()), "skill_use");
    const out = (await use.execute({ name: "git-commit" })) as { name: string; body: string };
    expect(out.name).toBe("git-commit");
    expect(out.body).toContain("# Git Commit");
  });

  it("skill_use returns a not-found message for an unknown skill", async () => {
    const use = byId(skillTools(makeSet()), "skill_use");
    const out = (await use.execute({ name: "missing" })) as { error: string };
    expect(out.error).toMatch(/not found/i);
  });
});
