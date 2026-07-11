import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelRequest, type StreamEvent } from "@eidentic/types";
import { Agent } from "../src/agent.js";

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

function systemText(req: ModelRequest): string {
  const sys = req.messages.find((m) => m.role === "system");
  return typeof sys?.content === "string" ? sys.content : "";
}

describe("spawn_agent — agent-as-tool (§8.2)", () => {
  it("the parent gets a spawn_agent tool that runs a sub-agent and returns its text", async () => {
    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([
      { content: [textBlock("the capital is Paris")], usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const child = new Agent({ permissions: { mode: "bypass" }, id: "researcher", instructions: "You research facts.", model: childModel, store: childStore });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "researcher", input: "capital of France?" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Done: Paris.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "lead", instructions: "Coordinate.", model: parentModel, store: parentStore,
      subAgents: { researcher: { agent: child, description: "Answers research questions." } },
    });

    const events = await run(parent, "find the capital of France", "p1");
    const toolResult = events.find((e) => e.type === "tool.result");
    expect(toolResult).toMatchObject({ toolName: "spawn_agent", isError: false });
    expect((toolResult as Extract<StreamEvent, { type: "tool.result" }>).output).toMatchObject({ output: "the capital is Paris" });
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "Done: Paris." });
  });

  it("spawn_agent description lists each sub-agent name + description", async () => {
    const a = new Agent({ permissions: { mode: "bypass" }, id: "a", instructions: "", model: new MockModel([]), store: await (async () => { const s = new InMemoryStore(); await s.migrate(); return s; })() });
    const parentModel = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "lead", instructions: "", model: parentModel, store: parentStore,
      subAgents: {
        searcher: { agent: a, description: "Searches the web." },
        reader: { agent: a, description: "Reads documents." },
      },
    });
    await run(parent, "go", "p2");
    const req = parentModel.calls[0]!;
    const schema = req.tools.find((t) => t.name === "spawn_agent")!;
    expect(schema).toBeDefined();
    expect(schema.description).toContain("searcher");
    expect(schema.description).toContain("Searches the web.");
    expect(schema.description).toContain("reader");
    expect(schema.description).toContain("Reads documents.");
  });
});

describe("context isolation (§8.3)", () => {
  it("the child's first model request contains its own instructions + input but NONE of the parent's history", async () => {
    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([
      { content: [textBlock("child answer")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const child = new Agent({ permissions: { mode: "bypass" }, id: "worker", instructions: "WORKER_SECRET_INSTRUCTIONS", model: childModel, store: childStore });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "worker", input: "ISOLATED_INPUT" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("synthesized")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "boss", instructions: "PARENT_SYSTEM_PROMPT_DO_NOT_LEAK", model: parentModel, store: parentStore,
      subAgents: { worker: { agent: child, description: "does work" } },
    });

    await run(parent, "PARENT_USER_MESSAGE_DO_NOT_LEAK", "p3");

    const childReq = childModel.calls[0]!;
    const sys = systemText(childReq);
    expect(sys).toContain("WORKER_SECRET_INSTRUCTIONS");
    // The invocation input crosses as the child's user message.
    const userMsg = childReq.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content === "string" ? userMsg.content : "").toBe("ISOLATED_INPUT");
    // None of the parent's system prompt or user history leaks into the child window.
    const all = JSON.stringify(childReq.messages);
    expect(all).not.toContain("PARENT_SYSTEM_PROMPT_DO_NOT_LEAK");
    expect(all).not.toContain("PARENT_USER_MESSAGE_DO_NOT_LEAK");
  });
});

describe("maxDepth via schema (§8.3)", () => {
  it("a sub-agent invoked at depth 1 has NO spawn_agent in its schema; the parent's schema has it", async () => {
    // Grandchild config (would be spawnable IF depth allowed) — but default maxDepth=1 blocks the child from spawning.
    const grandStore = new InMemoryStore(); await grandStore.migrate();
    const grandchild = new Agent({ permissions: { mode: "bypass" }, id: "grand", instructions: "", model: new MockModel([]), store: grandStore });

    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([
      { content: [textBlock("child done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    // The child itself declares subAgents — but at depth 1 with maxDepth 1 it must NOT receive spawn_agent.
    const child = new Agent({
      permissions: { mode: "bypass" },
      id: "child", instructions: "", model: childModel, store: childStore,
      subAgents: { grand: { agent: grandchild, description: "deep" } },
    });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "child", input: "x" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("parent done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "parent", instructions: "", model: parentModel, store: parentStore,
      subAgents: { child: { agent: child, description: "mid" } },
    });

    await run(parent, "go", "p4");

    const parentTools = parentModel.calls[0]!.tools.map((t) => t.name);
    expect(parentTools).toContain("spawn_agent");

    const childTools = childModel.calls[0]!.tools.map((t) => t.name);
    expect(childTools).not.toContain("spawn_agent");
  });

  it("maxDepth=2 lets the child spawn (its schema includes spawn_agent)", async () => {
    const grandStore = new InMemoryStore(); await grandStore.migrate();
    const grandchild = new Agent({ permissions: { mode: "bypass" }, id: "grand", instructions: "", model: new MockModel([{ content: [textBlock("g")], usage: { inputTokens: 1, outputTokens: 1 } }]), store: grandStore });

    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([{ content: [textBlock("c")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const child = new Agent({
      permissions: { mode: "bypass" },
      id: "child", instructions: "", model: childModel, store: childStore, maxDepth: 2,
      subAgents: { grand: { agent: grandchild, description: "deep" } },
    });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "child", input: "x" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "parent", instructions: "", model: parentModel, store: parentStore, maxDepth: 2,
      subAgents: { child: { agent: child, description: "mid" } },
    });

    await run(parent, "go", "p5");
    const childTools = childModel.calls[0]!.tools.map((t) => t.name);
    expect(childTools).toContain("spawn_agent");
  });
});

describe("typed structured output (§8.2)", () => {
  it("validates the child's final text against outputSchema and returns parsed data", async () => {
    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([
      { content: [textBlock('{"steps":["a","b","c"]}')], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const planner = new Agent({ permissions: { mode: "bypass" }, id: "planner", instructions: "Return JSON.", model: childModel, store: childStore });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "planner", input: "plan it" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "lead", instructions: "", model: parentModel, store: parentStore,
      subAgents: { planner: { agent: planner, description: "plans", outputSchema: z.object({ steps: z.array(z.string()) }) } },
    });

    const events = await run(parent, "go", "p6");
    const tr = events.find((e) => e.type === "tool.result") as Extract<StreamEvent, { type: "tool.result" }>;
    expect(tr.isError).toBe(false);
    expect((tr.output as { output: unknown }).output).toEqual({ steps: ["a", "b", "c"] });
  });

  it("returns a clear tool error when the child's text fails to parse/validate", async () => {
    const childStore = new InMemoryStore(); await childStore.migrate();
    const childModel = new MockModel([
      { content: [textBlock("not json at all")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const planner = new Agent({ permissions: { mode: "bypass" }, id: "planner", instructions: "", model: childModel, store: childStore });

    const parentStore = new InMemoryStore(); await parentStore.migrate();
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "planner", input: "plan it" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const parent = new Agent({
      permissions: { mode: "bypass" },
      id: "lead", instructions: "", model: parentModel, store: parentStore,
      subAgents: { planner: { agent: planner, description: "plans", outputSchema: z.object({ steps: z.array(z.string()) }) } },
    });

    const events = await run(parent, "go", "p7");
    const tr = events.find((e) => e.type === "tool.result") as Extract<StreamEvent, { type: "tool.result" }>;
    expect(tr.isError).toBe(true);
    expect(JSON.stringify(tr.output)).toMatch(/sub-agent .*output|parse|validate/i);
  });
});
