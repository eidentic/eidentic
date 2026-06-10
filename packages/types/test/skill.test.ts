import { describe, it, expect } from "vitest";
import type {
  SkillPort,
  SkillCatalogEntry,
  SkillProvenance,
  LoadedSkill,
} from "@eidentic/types";

// A minimal in-line fake proves the contract is implementable from @eidentic/types alone.
function makeFake(): SkillPort {
  const entries: SkillCatalogEntry[] = [{ name: "git-commit", description: "Write a commit." }];
  const prov: SkillProvenance = { source: "inline", contentHash: "abc123" };
  const loaded: LoadedSkill = {
    name: "git-commit",
    description: "Write a commit.",
    body: "# Git Commit\n...",
    allowedTools: ["bash"],
    memory: undefined,
    provenance: prov,
  };
  const memLog: string[] = [];
  return {
    catalog: () => entries,
    search: (query, topK) => (query.includes("commit") ? entries.slice(0, topK ?? 5) : []),
    use: async (name) => (name === "git-commit" ? loaded : null),
    recordOutcome: async (_name, note) => void memLog.push(note),
  };
}

describe("SkillPort shape", () => {
  it("catalog() returns name+description entries", () => {
    const s = makeFake();
    expect(s.catalog()).toEqual([{ name: "git-commit", description: "Write a commit." }]);
  });

  it("search() returns catalog entries; use() returns a LoadedSkill or null", async () => {
    const s = makeFake();
    expect(s.search("write a commit", 1)).toHaveLength(1);
    expect(s.search("unrelated", 1)).toEqual([]);
    const loaded = await s.use("git-commit");
    expect(loaded?.body).toContain("# Git Commit");
    expect(loaded?.provenance?.contentHash).toBe("abc123");
    expect(await s.use("missing")).toBeNull();
  });

  it("recordOutcome() resolves void", async () => {
    const s = makeFake();
    await expect(s.recordOutcome("git-commit", "worked")).resolves.toBeUndefined();
  });
});
