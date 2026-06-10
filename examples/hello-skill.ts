import { Agent } from "@eidentic/core";
import { SkillSet } from "@eidentic/skills";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";

// One inline SKILL.md (agentskills.io-compatible frontmatter + markdown body).
const GIT_COMMIT = `---
name: git-commit
description: |
  Use when the user wants to write a git commit message.
  Produces a Conventional Commit subject + body.
allowed-tools: [bash, read]
---
# Git Commit

Write a Conventional Commit:
- subject: imperative mood, <= 72 chars, no trailing period
- body: explain WHY, wrap at 72 cols
`;

const DB_MIGRATION = `---
name: db-migration
description: Use when generating database migrations from a schema change.
---
# DB Migration

Generate a forward + rollback migration. Always wrap DDL in a transaction.
`;

// 1) Build a SkillSet from in-memory manifests (the pure, no-I/O path).
const skills = SkillSet.fromManifests([
  { content: GIT_COMMIT, source: "inline:git-commit", author: "baran" },
  { content: DB_MIGRATION, source: "inline:db-migration" },
]);

// Tier-1: catalog (always-in-context).
console.log("catalog:");
for (const c of skills.catalog()) console.log(`  - ${c.name}: ${c.description.split("\n")[0]}`);

// Discovery: description-scored search.
console.log("\nsearch('commit'):", skills.search("commit").map((s) => s.name));

// Tier-2/3: load the full body (+ provenance + per-skill memory).
const loaded = await skills.use("git-commit");
console.log("\nuse('git-commit') body starts with:", JSON.stringify(loaded?.body.slice(0, 24)));
console.log("provenance:", loaded?.provenance);

// Per-skill memory (§7.5): record an outcome, then it surfaces on the next use.
await skills.recordOutcome("git-commit", "subjects over 72 chars get rejected by our linter");
console.log("memory after recordOutcome:", (await skills.use("git-commit"))?.memory);

// 2) Wire the skills into an Agent and script a skill_search -> skill_use flow.
const store = new InMemoryStore();
await store.migrate();
const model = new MockModel([
  { content: [toolUseBlock("c1", "skill_search", { query: "write a git commit" })], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [toolUseBlock("c2", "skill_use", { name: "git-commit" })], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [textBlock("feat: add the thing\n\nBecause it was missing.")], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agent = new Agent({ id: "skills-demo", instructions: "Help the user write good commits.", model, store, skills });

console.log("\n--- agent run ---");
for await (const e of agent.query("write me a commit for adding the thing", { sessionId: "s1" })) {
  if (e.type === "tool.result") console.log("tool", e.toolName, "->", JSON.stringify(e.output).slice(0, 80));
  if (e.type === "result") console.log("result:", e.subtype === "success" ? e.output : e.subtype);
}
