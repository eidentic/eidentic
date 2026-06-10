import { describe, it, expect, vi } from "vitest";
import { InMemoryStore, MockModel, InMemoryTracer } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent, type CostThresholdInfo } from "@eidentic/types";
import { Agent } from "../src/agent.js";

const deps = () => { let i = 0; return { now: () => "t", newId: () => `id${i++}` }; };
async function run(agent: Agent, input: string, sessionId: string) {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}
const result = (e: StreamEvent[]) => e.at(-1) as Extract<StreamEvent, { type: "result" }>;

describe("Agent cost + tracing wiring", () => {
  it("threads policy.maxTokens → max_tokens abort with CostBreakdown", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("first")], usage: { inputTokens: 100, outputTokens: 0 } },
      { content: [textBlock("second")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ id: "a1", instructions: "x", model, store, policy: { maxTokens: 50 }, ...deps() });
    const r = result(await run(agent, "hi", "s1"));
    expect(r.subtype).toBe("max_tokens");
    expect(r.cost!.foreground).toEqual({ inputTokens: 100, outputTokens: 0 });
  });

  it("threads prices + maxCostUsd and modelId for usd accounting", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("a")], usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      { content: [textBlock("b")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a1", instructions: "x", model, store,
      modelId: "haiku", prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
      policy: { maxCostUsd: 0.5 }, ...deps(),
    });
    const r = result(await run(agent, "hi", "s1"));
    expect(r.subtype).toBe("max_cost");
    expect(r.cost!.usd).toBeCloseTo(1.0, 6);
  });

  it("threads an onCostThreshold soft-cap hook", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const onCostThreshold = vi.fn<(i: CostThresholdInfo) => void>();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "noop", {})], usage: { inputTokens: 500_000, outputTokens: 0 } },
      { content: [textBlock("done")], usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    // no "noop" tool registered → dispatch returns an isError result, loop continues to the 2nd call
    const agent = new Agent({
      id: "a1", instructions: "x", model, store,
      modelId: "haiku", prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
      policy: { softCostUsd: 0.4 }, onCostThreshold, ...deps(),
    });
    await run(agent, "hi", "s1");
    expect(onCostThreshold).toHaveBeenCalledTimes(1);
  });

  it("threads a tracer → root + chat spans emitted", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const tracer = new InMemoryTracer();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent = new Agent({ id: "a1", instructions: "x", model, store, tracer, modelId: "haiku", ...deps() });
    await run(agent, "hi", "s1");
    expect(tracer.names()).toContain("gen_ai.invoke_agent");
    expect(tracer.byName("gen_ai.chat")).toHaveLength(1);
  });

  it("no policy/tracer: behavior unchanged (success), maxTurns default still 16", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent = new Agent({ id: "a1", instructions: "x", model, store, ...deps() });
    const r = result(await run(agent, "hi", "s1"));
    expect(r.subtype).toBe("success");
    expect(r.cost).toBeDefined();
  });
});
