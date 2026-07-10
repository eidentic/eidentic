import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type Scope, type StreamEvent } from "@eidentic/types";
import { Memory } from "@eidentic/memory";
import { Agent } from "../src/agent.js";

const userScope: Scope = { kind: "user", agentId: "sa", userId: "baran" };
// Note: `Memory` is already imported above; `userScope` is reused in graph tests below.

async function run(agent: Agent, input: string, sessionId: string, userId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId, userId })) out.push(e);
  return out;
}

describe("Agent graph tools", () => {
  it("a scripted graph_assert then graph_query drives the temporal KG end-to-end", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store, graph: store, blocks: { human: { value: "", description: "facts", limit: 500 } } });

    const model = new MockModel([
      { content: [toolUseBlock("c1", "graph_assert", { subject: "Baran", predicate: "favorite_language", object: "TypeScript" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "graph_query", { subject: "Baran" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Baran's favorite language is TypeScript.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      permissions: { mode: "bypass" },
      id: "ga", instructions: "Use the knowledge graph.", model, store, memory,
      now: () => "t", newId: ((n) => () => `g${n++}`)(0),
    });

    const out = await run(agent, "Baran loves TypeScript; what is his favorite language?", "s1", "baran");
    expect(out.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    const graphScope: Scope = { kind: "user", agentId: "ga", userId: "baran" };
    const facts = await memory.queryFacts({ scope: graphScope, subject: "Baran" });
    expect(facts.map((f) => f.object)).toEqual(["TypeScript"]);
  });

  it("graph tools are absent when memory has no graph (registry unchanged path)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store, blocks: { human: { value: "", description: "facts", limit: 500 } } }); // NO graph
    const model = new MockModel([
      // model tries graph_assert but it must be an unknown tool → error result, then a final answer
      { content: [toolUseBlock("c1", "graph_assert", { subject: "x", predicate: "y", object: "z" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ permissions: { mode: "bypass" }, id: "ng", instructions: "x", model, store, memory, now: () => "t", newId: ((n) => () => `n${n++}`)(0) });
    const events = await run(agent, "hi", "s2", "baran");
    // graph_assert must be UNREGISTERED: the tool.result must report "unknown tool"
    const toolResults = events.filter((e) => e.type === "tool.result");
    expect(JSON.stringify(toolResults)).toMatch(/unknown tool/i);
    // the tool schema sent to the model must not include graph_assert or graph_query
    const toolNames = model.calls[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("graph_assert");
    expect(toolNames).not.toContain("graph_query");
  });
});

describe("Agent self-editing memory", () => {
  it("a scripted memory_append edits the human block and persists in the store", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store, blocks: { human: { value: "", description: "facts about the user", limit: 500 } } });

    const model = new MockModel([
      { content: [toolUseBlock("c1", "memory_append", { label: "human", text: "Name: Baran\n" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Saved.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      permissions: { mode: "bypass" },
      id: "sa", instructions: "Remember durable facts.", model, store, memory,
      now: () => "t", newId: ((n) => () => `id${n++}`)(0),
    });

    const out = await run(agent, "My name is Baran", "s1", "baran");
    expect(out.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "Saved." });
    const human = (await store.getBlocks(userScope)).find((b) => b.label === "human");
    expect(human?.value).toContain("Name: Baran");
  });

  it("the edited block appears in the system message of a NEW session under the same user scope", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store, blocks: { human: { value: "", description: "facts about the user", limit: 500 } } });

    const model1 = new MockModel([
      { content: [toolUseBlock("c1", "memory_append", { label: "human", text: "Name: Baran\n" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Saved.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent1 = new Agent({ permissions: { mode: "bypass" }, id: "sa", instructions: "Remember.", model: model1, store, memory, now: () => "t", newId: ((n) => () => `a${n++}`)(0) });
    await run(agent1, "My name is Baran", "s1", "baran");

    const model2 = new MockModel([{ content: [textBlock("Hi Baran.")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent2 = new Agent({ permissions: { mode: "bypass" }, id: "sa", instructions: "Greet.", model: model2, store, memory, now: () => "t", newId: ((n) => () => `b${n++}`)(0) });
    await run(agent2, "hello again", "s2", "baran");

    const system = model2.calls[0]!.messages[0]!.content as string;
    expect(system).toContain("Name: Baran");
    expect(system).toContain("<human v=1");
  });
});
