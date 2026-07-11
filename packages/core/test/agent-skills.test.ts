import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { SkillSet } from "@eidentic/skills";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

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

const CAPABILITY_SKILL = `---
name: bounded
description: Uses only the explicitly approved helper.
allowed-tools: [allowed_tool]
---
# Bounded

Use the approved helper only.
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

    const context = String(model.calls[0]!.messages.find((message) =>
      message.role === "user" && String(message.content).includes("<skills>"),
    )?.content);
    expect(context).toContain("<skills>");
    expect(context).toContain("- git-commit:");
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

  it("enforces prompt-skill allowed-tools in schema and dispatch", async () => {
    const store = new InMemoryStore();
    const skills = SkillSet.fromManifests([{ content: CAPABILITY_SKILL, source: "inline:bounded" }]);
    const allowed = createTool({
      id: "allowed_tool",
      description: "Allowed helper",
      inputSchema: z.object({}),
      sideEffect: "read-only",
      execute: async () => "allowed",
    });
    const forbidden = createTool({
      id: "forbidden_tool",
      description: "Forbidden helper",
      inputSchema: z.object({}),
      sideEffect: "read-only",
      execute: async () => "SHOULD_NOT_RUN",
    });
    const model = new MockModel([
      { content: [toolUseBlock("use", "skill_use", { name: "bounded" })], usage: { inputTokens: 1, outputTokens: 1 } },
      {
        content: [
          toolUseBlock("ok", "allowed_tool", {}),
          toolUseBlock("no", "forbidden_tool", {}),
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "bounded-agent",
      instructions: "Use skills safely.",
      model,
      store,
      skills,
      tools: [allowed, forbidden],
    });

    const events = await run(agent, "use bounded", "bounded-session");
    const results = events.filter((event) => event.type === "tool.result");
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "allowed_tool", output: "allowed", isError: false }),
      expect.objectContaining({
        toolName: "forbidden_tool",
        isError: true,
        output: expect.objectContaining({ error: expect.stringMatching(/active skill.*does not allow/i) }),
      }),
    ]));
    expect(model.calls[1]!.tools.map((tool) => tool.name)).toContain("allowed_tool");
    expect(model.calls[1]!.tools.map((tool) => tool.name)).not.toContain("forbidden_tool");
  });

  it("restores the active skill capability from durable session history", async () => {
    const store = new InMemoryStore();
    const skills = SkillSet.fromManifests([{ content: CAPABILITY_SKILL, source: "inline:bounded" }]);
    const forbidden = createTool({
      id: "forbidden_tool",
      description: "Forbidden helper",
      inputSchema: z.object({}),
      sideEffect: "read-only",
      execute: async () => "SHOULD_NOT_RUN",
    });
    const model = new MockModel([
      { content: [toolUseBlock("use", "skill_use", { name: "bounded" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("first done")], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("no", "forbidden_tool", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("second done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "restored-skill-agent",
      instructions: "Use skills safely.",
      model,
      store,
      skills,
      tools: [forbidden],
    });
    await run(agent, "activate", "skill-history-session");
    const second = await run(agent, "continue", "skill-history-session");
    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.result",
        toolName: "forbidden_tool",
        isError: true,
        output: expect.objectContaining({ error: expect.stringMatching(/active skill.*does not allow/i) }),
      }),
    ]));
    expect(model.calls[2]!.tools.map((tool) => tool.name)).not.toContain("forbidden_tool");
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
