import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel, InMemoryTracer } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { createTool, ToolRegistry } from "../src/tool.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/loop.js";
import { Memory } from "@eidentic/memory";

const ping = createTool({ id: "ping", description: "pong", inputSchema: z.object({}), execute: async () => ({ reply: "pong" }) });
const boom = createTool({ id: "boom", description: "throws", inputSchema: z.object({}), sideEffect: "idempotent", execute: async () => { throw new Error("kaboom"); } });

function deps(n = 0) { let i = n; return { now: () => "t", newId: () => `id${i++}` }; }
async function drain(it: AsyncIterable<StreamEvent>) { for await (const _ of it) { /* drain */ } }

describe("OTel tracing", () => {
  it("emits a root gen_ai.invoke_agent span with a gen_ai.chat child per model call and gen_ai.execute_tool per tool", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const tracer = new InMemoryTracer();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    await drain(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, modelId: "haiku", tracer,
    }));

    const names = tracer.names();
    expect(names).toContain("gen_ai.invoke_agent");
    expect(names.filter((n) => n === "gen_ai.chat")).toHaveLength(2);
    expect(names.filter((n) => n === "gen_ai.execute_tool")).toHaveLength(1);

    const root = tracer.byName("gen_ai.invoke_agent")[0]!;
    expect(root.attributes["gen_ai.agent.id"]).toBe("a1");
    expect(root.attributes["eidentic.scope"]).toBe("agent:a1");
    expect(root.ended).toBe(true);

    const chat = tracer.byName("gen_ai.chat")[0]!;
    expect(chat.attributes["gen_ai.request.model"]).toBe("haiku");
    expect(chat.attributes["gen_ai.usage.input_tokens"]).toBe(5);
    expect(chat.attributes["gen_ai.usage.output_tokens"]).toBe(2);

    const tool = tracer.byName("gen_ai.execute_tool")[0]!;
    expect(tool.attributes["gen_ai.tool.name"]).toBe("ping");
    expect(tool.status).toBe("ok");
  });

  it("sets error status on the gen_ai.execute_tool span when the tool result isError", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const tracer = new InMemoryTracer();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "boom", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    await drain(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([boom]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, tracer,
    }));
    expect(tracer.byName("gen_ai.execute_tool")[0]!.status).toBe("error");
  });

  it("sets gen_ai.usage.* totals and eidentic.cost_usd on the root span at end", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const tracer = new InMemoryTracer();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1_000_000, outputTokens: 0 } }]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    await drain(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, modelId: "haiku", tracer,
      prices: { haiku: { inputPerMTok: 2, outputPerMTok: 6 } },
    }));
    const root = tracer.byName("gen_ai.invoke_agent")[0]!;
    expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(1_000_000);
    expect(root.attributes["gen_ai.usage.output_tokens"]).toBe(0);
    expect(root.attributes["eidentic.cost_usd"]).toBeCloseTo(2.0, 6);
  });

  it("emits memory.retrieve and memory.ingest spans when memory is present", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const tracer = new InMemoryTracer();
    const memory = new Memory({ store });
    const model = new MockModel([{ content: [textBlock("noted")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    await drain(runTurn({
      agentId: "a1", instructions: "x", input: "remember this", model,
      registry: new ToolRegistry([]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, tracer, memory,
    }));
    expect(tracer.names()).toContain("memory.retrieve");
    expect(tracer.names()).toContain("memory.ingest");
  });

  it("no-tracer path: identical terminal result, no spans (zero overhead)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 2, outputTokens: 1 } }]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const out: StreamEvent[] = [];
    for await (const e of runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, // no tracer
    })) out.push(e);
    expect(out.map((e) => e.type)).toEqual(["session.init", "assistant", "result"]);
  });
});
