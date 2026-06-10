import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, type StreamEvent } from "@eidentic/types";
import { createTool, ToolRegistry } from "../src/tool.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/loop.js";

const noop = createTool({
  id: "noop",
  description: "noop",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

function deps(n = 0) {
  let i = n;
  return { now: () => "t", newId: () => `id${i++}` };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const result = (events: StreamEvent[]) =>
  events.at(-1) as Extract<StreamEvent, { type: "result" }>;

// Model with cachedInputPerMTok set (10% of input rate)
const PRICES_WITH_CACHE = {
  "test-model": { inputPerMTok: 3.0, outputPerMTok: 15.0, cachedInputPerMTok: 0.3 },
};

// Model WITHOUT cachedInputPerMTok — cached tokens billed at input rate (back-compat)
const PRICES_NO_CACHE = {
  "test-model": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
};

describe("usdFor — cached input token split", () => {
  it("prices cached tokens at cachedInputPerMTok and non-cached at inputPerMTok", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // 1,000 input (500 cached) + 200 output
    const model = new MockModel([
      {
        content: [textBlock("ok")],
        usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500 },
      },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(
      runTurn({
        agentId: "a1",
        instructions: "x",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        modelId: "test-model",
        prices: PRICES_WITH_CACHE,
      }),
    );
    const r = result(events);
    expect(r.subtype).toBe("success");
    // Expected USD:
    //   non-cached: 500 * 3.0 / 1e6 = 0.0015
    //   cached:     500 * 0.3 / 1e6 = 0.00015
    //   output:     200 * 15.0 / 1e6 = 0.003
    //   total = 0.00465
    expect(r.cost!.usd).toBeCloseTo(0.00465, 6);
  });

  it("vs full input rate: cached tokens yield a lower USD than billing all at inputPerMTok", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      {
        content: [textBlock("ok")],
        usage: { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 500 },
      },
    ]);
    const session = await Session.open(store, { sessionId: "s2", agentId: "a1", ...deps() });
    const events = await collect(
      runTurn({
        agentId: "a1",
        instructions: "x",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        modelId: "test-model",
        prices: PRICES_WITH_CACHE,
      }),
    );
    const r = result(events);
    // with cache: 500*3 + 500*0.3 = 1650 / 1e6 = 0.00165
    // without cache would be: 1000*3 / 1e6 = 0.003
    expect(r.cost!.usd).toBeCloseTo(0.00165, 6);
    expect(r.cost!.usd!).toBeLessThan(0.003);
  });

  it("back-compat: when cachedInputPerMTok is absent, cached tokens billed at inputPerMTok", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      {
        content: [textBlock("ok")],
        usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500 },
      },
    ]);
    const session = await Session.open(store, { sessionId: "s3", agentId: "a1", ...deps() });
    const events = await collect(
      runTurn({
        agentId: "a1",
        instructions: "x",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        modelId: "test-model",
        prices: PRICES_NO_CACHE,
      }),
    );
    const r = result(events);
    // All 1000 input billed at 3.0, 200 output at 15.0
    // = (1000*3 + 200*15) / 1e6 = (3000+3000)/1e6 = 0.006
    expect(r.cost!.usd).toBeCloseTo(0.006, 6);
  });

  it("clamps cachedInputTokens > inputTokens to inputTokens (guard)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Malformed usage: cached=2000 > input=1000 — should be clamped
    const model = new MockModel([
      {
        content: [textBlock("ok")],
        usage: { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 2000 },
      },
    ]);
    const session = await Session.open(store, { sessionId: "s4", agentId: "a1", ...deps() });
    const events = await collect(
      runTurn({
        agentId: "a1",
        instructions: "x",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        modelId: "test-model",
        prices: PRICES_WITH_CACHE,
      }),
    );
    const r = result(events);
    // clamped: cached=1000, uncached=0 → all at cache rate 0.3/MTok
    expect(r.cost!.usd).toBeCloseTo(1000 * 0.3 / 1_000_000, 6);
  });

  it("zero cachedInputTokens: full input billed at inputPerMTok (existing behavior unchanged)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      {
        content: [textBlock("ok")],
        usage: { inputTokens: 500, outputTokens: 100 },
      },
    ]);
    const session = await Session.open(store, { sessionId: "s5", agentId: "a1", ...deps() });
    const events = await collect(
      runTurn({
        agentId: "a1",
        instructions: "x",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        modelId: "test-model",
        prices: PRICES_WITH_CACHE,
      }),
    );
    const r = result(events);
    // 500*3 + 100*15 = 1500+1500 = 3000 / 1e6 = 0.003
    expect(r.cost!.usd).toBeCloseTo(0.003, 6);
  });
});
