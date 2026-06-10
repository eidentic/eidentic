import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { SkillSet } from "@eidentic/skills";
import { Agent } from "../src/agent.js";

const PROMPT_SKILL_MD = `---
name: summarize
description: Summarizes the given text concisely.
---
# Summarize

Write a concise summary.
`;

const GIT_COMMIT = `---
name: git-commit
description: Use when the user wants to write a git commit message.
---
# Git Commit

Write a Conventional Commit. Subject <= 72 chars.
`;

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

describe("Agent skill tools", () => {
  it("a scripted skill_search then skill_use drives discovery+load end-to-end", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const skills = SkillSet.fromManifests([{ content: GIT_COMMIT, source: "inline:git-commit" }]);

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_search", { query: "write a commit message" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "skill_use", { name: "git-commit" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("feat: add thing")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "sk", instructions: "Help write commits.", model, store, skills,
      now: () => "t", newId: ((n) => () => `s${n++}`)(0),
    });

    const out = await run(agent, "write me a commit", "s1");
    expect(out.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // skill_search result is in the tool.result stream and surfaces git-commit
    const toolResults = out.filter((e) => e.type === "tool.result");
    expect(JSON.stringify(toolResults)).toContain("git-commit");
    // skill_use returned the body
    expect(JSON.stringify(toolResults)).toContain("Conventional Commit");

    // The <skills> catalog was injected into the system prompt
    const system = String(model.calls[0]!.messages[0]!.content);
    expect(system).toContain("<skills>");
    expect(system).toContain("- git-commit:");
  });

  it("skill tools are absent when no skills are configured (registry + prompt unchanged)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_search", { query: "x" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ id: "ns", instructions: "x", model, store, now: () => "t", newId: ((n) => () => `n${n++}`)(0) });
    const events = await run(agent, "hi", "s2");
    // skill_search must be UNREGISTERED → unknown tool error
    expect(JSON.stringify(events.filter((e) => e.type === "tool.result"))).toMatch(/unknown tool/i);
    // tool schemas sent to the model must not include skill_*
    const toolNames = model.calls[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("skill_search");
    expect(toolNames).not.toContain("skill_use");
    // system prompt has no <skills> block
    expect(String(model.calls[0]!.messages[0]!.content)).toBe("x");
  });
});

describe("Agent.skillCatalog()", () => {
  it("returns catalog entries when a SkillSet is configured", () => {
    const skills = SkillSet.fromManifests([{ content: PROMPT_SKILL_MD, source: "inline:summarize" }]);
    const agent = new Agent({
      id: "cat-agent",
      instructions: "Test agent.",
      model: new MockModel([]),
      store: new InMemoryStore(),
      skills,
    });
    const catalog = agent.skillCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ name: "summarize", description: "Summarizes the given text concisely." });
  });

  it("returns [] when no skills are configured", () => {
    const agent = new Agent({
      id: "no-skills-agent",
      instructions: "No skills.",
      model: new MockModel([]),
      store: new InMemoryStore(),
    });
    expect(agent.skillCatalog()).toEqual([]);
  });
});
