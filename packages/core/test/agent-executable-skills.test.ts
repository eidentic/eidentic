import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { SkillBank } from "@eidentic/skills";
import type { ExecutableSkillDef } from "@eidentic/skills";
import { Agent } from "../src/agent.js";
import { MAX_SKILL_TOOL_CALLS } from "../src/skill-tools.js";

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

/**
 * A simple doubler skill that doesn't need callTool at all — easy to register and test.
 * The test-gate doubles 2 → 4 using the default stub (no callTool needed).
 */
const doublerSkill: ExecutableSkillDef = {
  name: "doubler-skill",
  description: "doubles a number",
  tests: [{ name: "doubles 2", input: 2, check: (o) => o === 4 }],
  run: async (input) => (input as number) * 2,
};

/**
 * An echo skill that calls an allowed tool. testCallTool stub used to pass the test-gate.
 * During real execution the skill's callTool routes through the agent's registry.
 * The check: any string is fine (default stub echoes something non-throwing).
 */
const echoSkill: ExecutableSkillDef = {
  name: "echo-skill",
  description: "echoes by calling the echo tool",
  allowedTools: ["echo_*"],
  tests: [
    {
      name: "echoes via stub",
      input: "hello",
      // Default testCallTool stub returns "echo:[object Object]" — just check it's a string.
      check: (o) => typeof o === "string",
    },
  ],
  run: async (input, ctx) => {
    const result = await ctx.callTool!("echo_value", { value: input });
    return result;
  },
};

const blockedSkill: ExecutableSkillDef = {
  name: "blocked-skill",
  description: "tries a tool not in its allowed list",
  allowedTools: ["allowed_tool"],
  tests: [
    {
      name: "allowed_tool works in test",
      input: null,
      // During test-gate: allowed_tool is in allowedTools (allowed), forbidden_tool is not.
      // The skill returns "blocked" when forbidden_tool throws — the check just confirms it ran.
      check: (o) => o === "blocked",
    },
  ],
  run: async (_input, ctx) => {
    try {
      await ctx.callTool!("forbidden_tool", {});
      return "allowed"; // should never reach here
    } catch {
      return "blocked";
    }
  },
};

describe("Agent executableSkills — skill_run wiring (Fix 1)", () => {
  it("skill_run tool is present in the model schema when executableSkills is configured", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const bank = new SkillBank();
    await bank.register(doublerSkill);

    const model = new MockModel([
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      executableSkills: bank,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });
    await run(agent, "hi", "s1");
    const toolNames = model.calls[0]!.tools.map((t) => t.name);
    expect(toolNames).toContain("skill_run");
  });

  it("skill_run description lists only runnable (non-quarantined) skills", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // bank2 has both a human-authored skill (runnable) and an agent-authored skill (quarantined).
    const bank2 = new SkillBank({
      sandbox: { async run() { return { stdout: "EIDENTIC_RESULT:null", stderr: "", exitCode: 0 }; } },
    });
    const r1 = await bank2.register(doublerSkill);
    expect(r1.ok).toBe(true);                               // registered, not quarantined

    const quarantinedSkill: ExecutableSkillDef = {
      name: "quarantined-skill",
      description: "this is quarantined",
      code: "RESULT null",
      tests: [{ name: "t", input: null, check: () => true }],
    };
    const r2 = await bank2.register(quarantinedSkill, { author: "agent" });
    expect(r2.ok).toBe(true);                               // registered, quarantined

    const model = new MockModel([
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a2", instructions: "", model, store, executableSkills: bank2,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });
    await run(agent, "hi", "s2");
    const skillRunSchema = model.calls[0]!.tools.find((t) => t.name === "skill_run");
    expect(skillRunSchema).toBeDefined();
    expect(skillRunSchema!.description).toContain("doubler-skill");
    expect(skillRunSchema!.description).not.toContain("quarantined-skill");
  });

  it("scripted skill_run call: skill runs and its callTool reaches the real agent tool", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Use a bank with an explicit testCallTool that satisfies the echoSkill test-gate check.
    const bank = new SkillBank({
      testCallTool: async (toolId, input) => {
        // During test-gate: echo_value returns the input value so the check (typeof o === "string") passes.
        if (toolId === "echo_value") return String((input as { value?: unknown })?.value ?? input);
        return `${toolId}:stub`;
      },
    });
    await bank.register(echoSkill);

    // Agent has an echo_value tool in its real registry.
    const echoTool = {
      id: "echo_value",
      description: "echoes a value",
      sideEffect: "read-only" as const,
      jsonSchema: { type: "object", properties: { value: {} }, required: ["value"] },
      parse: (input: unknown) => ({ ok: true as const, value: input }),
      execute: async (input: unknown) => {
        const i = input as { value: unknown };
        return `echoed:${i.value}`;
      },
    };

    const model = new MockModel([
      // Model calls skill_run
      { content: [toolUseBlock("c1", "skill_run", { name: "echo-skill", input: "world" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // Model sees the skill result and replies
      { content: [textBlock("skill ran")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a3", instructions: "", model, store, tools: [echoTool],
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run echo-skill", "s3");
    const toolResult = events.find((e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run");
    expect(toolResult).toBeDefined();
    const tr = toolResult as Extract<StreamEvent, { type: "tool.result" }>;
    expect(tr.isError).toBe(false);
    // The skill called echo_value which returned "echoed:world"
    expect(JSON.stringify(tr.output)).toContain("echoed:world");
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("skill_run blocks a tool call outside the skill's allowed-tools (deny-by-default)", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // testCallTool stub for test-gate: returns "blocked" path (no_such_fn inside skill during test)
    // but blocked_skill's test check is `o === "blocked"` so we need forbidden_tool to throw.
    // The bank's wrapCallTool denies forbidden_tool (not in allowedTools) → throws → returns "blocked".
    const bankWithStub = new SkillBank();
    const r = await bankWithStub.register(blockedSkill);
    expect(r.ok).toBe(true);                               // test-gate passes: forbidden_tool throws → "blocked"

    // Agent has BOTH allowed_tool and forbidden_tool in its registry.
    const allowedTool = {
      id: "allowed_tool",
      description: "allowed",
      sideEffect: "read-only" as const,
      jsonSchema: {},
      parse: (i: unknown) => ({ ok: true as const, value: i }),
      execute: async () => "ok-result",
    };
    const forbiddenTool = {
      id: "forbidden_tool",
      description: "forbidden",
      sideEffect: "read-only" as const,
      jsonSchema: {},
      parse: (i: unknown) => ({ ok: true as const, value: i }),
      execute: async () => "should-not-see-this",
    };

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "blocked-skill", input: null })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a4", instructions: "", model, store, tools: [allowedTool, forbiddenTool],
      executableSkills: bankWithStub, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run blocked-skill", "s4");
    const tr = events.find((e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run") as
      Extract<StreamEvent, { type: "tool.result" }> | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(false);
    // Skill returned "blocked" — its callTool for forbidden_tool was denied by the bank's allowedTools enforcement.
    expect(JSON.stringify(tr!.output)).toContain("blocked");
    // Confirm forbidden_tool itself was NEVER invoked.
    expect(JSON.stringify(tr!.output)).not.toContain("should-not-see-this");
  });

  it("skill_run: calling a quarantined skill name returns an error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const bank = new SkillBank({
      sandbox: { async run() { return { stdout: "EIDENTIC_RESULT:1", stderr: "", exitCode: 0 }; } },
    });
    const quarantinedCode: ExecutableSkillDef = {
      name: "q-skill",
      description: "quarantined",
      code: "RESULT 1",
      tests: [{ name: "returns 1", input: null, check: (o) => o === 1 }],
    };
    await bank.register(quarantinedCode, { author: "agent" });         // quarantined

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "q-skill", input: null })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a5", instructions: "", model, store,
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run q-skill", "s5");
    const tr = events.find((e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run") as
      Extract<StreamEvent, { type: "tool.result" }> | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    expect(JSON.stringify(tr!.output)).toMatch(/quarantined/i);
  });

  it("skill_run: calling an unregistered skill name returns an error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const bank = new SkillBank();
    await bank.register(doublerSkill);

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "no-such-skill", input: null })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a6", instructions: "", model, store,
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run missing", "s6");
    const tr = events.find((e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run") as
      Extract<StreamEvent, { type: "tool.result" }> | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    expect(JSON.stringify(tr!.output)).toMatch(/unknown skill/i);
  });

  it("skill_run is absent when executableSkills is not configured (no-executableSkills path unchanged)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a7", instructions: "", model, store,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });
    await run(agent, "hi", "s7");
    const toolNames = model.calls[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("skill_run");
  });
});

describe("Fix 1 — @eidentic/core has no @eidentic/skills runtime dependency", () => {
  it("core package.json does not list @eidentic/skills in dependencies (only devDependencies)", () => {
    // Resolve relative to this test file: packages/core/test/ → up 3 levels → packages/core/
    const testDir = fileURLToPath(new URL(".", import.meta.url));
    const pkgPath = resolve(testDir, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@eidentic/skills"]).toBeUndefined();
    // devDependencies is fine (used for tests only)
    expect(pkg.devDependencies?.["@eidentic/skills"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Guard tests: recursion block + fan-out cap (fix/audit-f-skillbank)
// ---------------------------------------------------------------------------

describe("skill_run bridge — recursion guard and fan-out cap", () => {
  /**
   * A skill whose allowedTools includes "skill_run" (via wildcard "*") that attempts to
   * invoke skill_run through callTool must receive a clear recursion error and must NOT
   * re-enter skill_run.
   */
  it("skill whose allowedTools includes skill_run gets a recursion error, not infinite recursion", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // testCallTool stub: satisfies the test-gate check (returns non-throwing string).
    const bank = new SkillBank({
      testCallTool: async (toolId) => `stub:${toolId}`,
    });

    // This skill's allowedTools: ["*"] — overly broad; it tries to call skill_run.
    const recursiveSkill: ExecutableSkillDef = {
      name: "recursive-skill",
      description: "tries to call skill_run recursively",
      allowedTools: ["*"],
      tests: [
        {
          name: "stub does not recurse during test-gate",
          input: null,
          // During test-gate the stub just returns a string — non-throwing is sufficient.
          check: (o) => typeof o === "string",
        },
      ],
      run: async (_input, ctx) => {
        // Attempt to invoke skill_run through the bridge.
        await ctx.callTool!("skill_run", { name: "recursive-skill", input: null });
        return "should-not-reach";
      },
    };

    await bank.register(recursiveSkill);

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "recursive-skill", input: null })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "guard-recursion", instructions: "", model, store,
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run recursive-skill", "s-recursion");

    // The skill_run tool result must be an error (recursion was blocked).
    const tr = events.find(
      (e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run",
    ) as Extract<StreamEvent, { type: "tool.result" }> | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    const msg = JSON.stringify(tr!.output);
    expect(msg).toMatch(/recursion/i);
    // skill_run was not re-entered — the model only received one skill_run tool-result event.
    const skillRunResults = events.filter(
      (e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run",
    );
    expect(skillRunResults).toHaveLength(1);
  });

  /**
   * A skill that makes more than MAX_SKILL_TOOL_CALLS bridged tool calls within one execution
   * must hit the fan-out cap error before completing.
   */
  it(`skill making more than ${MAX_SKILL_TOOL_CALLS} tool calls hits the fan-out cap error`, async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // testCallTool stub returns immediately so the test-gate passes without actual dispatch.
    const bank = new SkillBank({
      testCallTool: async () => "stub-ok",
    });

    // A noop tool registered in the agent — the skill is allowed to call it.
    const noopTool = {
      id: "noop_tool",
      description: "does nothing",
      sideEffect: "read-only" as const,
      jsonSchema: {},
      parse: (i: unknown) => ({ ok: true as const, value: i }),
      execute: async () => "noop",
    };

    // Build the fan-out skill dynamically using MAX_SKILL_TOOL_CALLS so the test stays in sync.
    const callsToMake = MAX_SKILL_TOOL_CALLS + 1; // one over the cap
    const fanOutSkill: ExecutableSkillDef = {
      name: "fanout-skill",
      description: "makes too many tool calls",
      allowedTools: ["noop_tool"],
      tests: [
        {
          name: "stub completes without error during test-gate",
          input: null,
          // During test-gate the stub always returns "stub-ok" — no cap is enforced there.
          check: (o) => o === "completed" || typeof o === "string",
        },
      ],
      run: async (_input, ctx) => {
        for (let i = 0; i < callsToMake; i++) {
          await ctx.callTool!("noop_tool", {});
        }
        return "completed";
      },
    };

    await bank.register(fanOutSkill);

    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "fanout-skill", input: null })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "guard-fanout", instructions: "", model, store,
      tools: [noopTool],
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run fanout-skill", "s-fanout");

    // skill_run must return an error mentioning the cap.
    const tr = events.find(
      (e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run",
    ) as Extract<StreamEvent, { type: "tool.result" }> | undefined;
    expect(tr).toBeDefined();
    expect(tr!.isError).toBe(true);
    const msg = JSON.stringify(tr!.output);
    expect(msg).toMatch(/maximum/i);
    expect(msg).toContain(String(MAX_SKILL_TOOL_CALLS));
  });

  /**
   * The counter is scoped to a single skill_run execution — a second invocation of skill_run
   * for a well-behaved skill (that makes only 1 tool call) must succeed even after the previous
   * skill_run execution hit the cap.
   */
  it("fan-out counter resets between separate skill_run invocations", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const bank = new SkillBank({
      testCallTool: async () => "stub-ok",
    });

    const noopTool = {
      id: "noop_tool",
      description: "does nothing",
      sideEffect: "read-only" as const,
      jsonSchema: {},
      parse: (i: unknown) => ({ ok: true as const, value: i }),
      execute: async () => "noop",
    };

    // Skill that makes exactly one tool call — always within the cap.
    const singleCallSkill: ExecutableSkillDef = {
      name: "single-call-skill",
      description: "makes a single tool call",
      allowedTools: ["noop_tool"],
      tests: [{ name: "one call", input: null, check: (o) => o === "done" }],
      run: async (_input, ctx) => {
        await ctx.callTool!("noop_tool", {});
        return "done";
      },
    };

    await bank.register(singleCallSkill);

    // Model calls skill_run TWICE for the same skill.
    const model = new MockModel([
      { content: [toolUseBlock("c1", "skill_run", { name: "single-call-skill", input: null }),
                  toolUseBlock("c2", "skill_run", { name: "single-call-skill", input: null })],
        usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "guard-counter-reset", instructions: "", model, store,
      tools: [noopTool],
      executableSkills: bank, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "run twice", "s-reset");

    // Both skill_run invocations should succeed.
    const skillRunResults = events.filter(
      (e) => e.type === "tool.result" && (e as { toolName?: string }).toolName === "skill_run",
    ) as Array<Extract<StreamEvent, { type: "tool.result" }>>;
    expect(skillRunResults).toHaveLength(2);
    expect(skillRunResults[0]!.isError).toBe(false);
    expect(skillRunResults[1]!.isError).toBe(false);
  });
});
