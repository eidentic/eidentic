/**
 * Feature 2 — Per-turn cost visibility.
 *
 * Tests cover:
 *  1. Each `assistant` stream event carries the turn's `usage`.
 *  2. The terminal `result` event carries a running USD total in `cost.usd`.
 *  3. Multi-turn runs: each assistant event reflects ONLY that turn's usage (not cumulative).
 *  4. Terminal result's `usage` is the CUMULATIVE usage across all turns.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { z } from "zod";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.at(-1);
  if (!t || t.type !== "result") throw new Error(`last event is not a result; got ${JSON.stringify(t)}`);
  return t as Extract<StreamEvent, { type: "result" }>;
}

async function freshStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

const noop = createTool({
  id: "noop",
  description: "does nothing",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

// ---------------------------------------------------------------------------
// Test 1: Single-turn — assistant event carries per-turn usage
// ---------------------------------------------------------------------------

describe("Feature 2 — per-turn cost: assistant event carries usage", () => {
  it("a single-turn run emits an assistant event with the turn's usage", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [textBlock("hello")], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("hi", { sessionId: "s-per-turn-1" }));

    // Find the assistant event (first model response).
    const assistantEvents = events.filter((e) => e.type === "assistant");
    expect(assistantEvents).toHaveLength(1);
    const assistantEvent = assistantEvents[0] as Extract<StreamEvent, { type: "assistant" }>;

    // Per-turn usage must be present and match the scripted model response.
    expect(assistantEvent.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // Terminal result must carry cumulative usage (same in a single-turn run).
    const result = terminal(events);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Multi-turn — each assistant event reflects its OWN turn only
// ---------------------------------------------------------------------------

describe("Feature 2 — per-turn cost: multi-turn run — each assistant event has its own turn's usage", () => {
  it("two-turn run: first assistant event has turn-1 usage, second has turn-2 usage", async () => {
    const store = await freshStore();
    const model = new MockModel([
      // Turn 1: calls a tool
      { content: [toolUseBlock("c1", "noop", {})], usage: { inputTokens: 10, outputTokens: 3 } },
      // Turn 2: final text response
      { content: [textBlock("all done")], usage: { inputTokens: 15, outputTokens: 7 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [noop],
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-per-turn-multi" }));

    const assistantEvents = events.filter((e) => e.type === "assistant") as Extract<StreamEvent, { type: "assistant" }>[];
    expect(assistantEvents).toHaveLength(2);

    // Each assistant event reflects ONLY that turn's usage.
    expect(assistantEvents[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(assistantEvents[1]!.usage).toEqual({ inputTokens: 15, outputTokens: 7 });

    // Terminal result usage is cumulative across all turns.
    const result = terminal(events);
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 10 });
  });
});

// ---------------------------------------------------------------------------
// Test 3: Terminal result carries USD cost when prices are configured
// ---------------------------------------------------------------------------

describe("Feature 2 — per-turn cost: terminal result has cost.usd when prices configured", () => {
  it("terminal result.cost.usd is computed from cumulative usage + price table", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
    ]);
    model.modelId = "test-model";

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelId: "test-model",
      prices: {
        "test-model": { inputPerMTok: 1.0, outputPerMTok: 2.0 },
      },
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("hi", { sessionId: "s-usd-cost" }));
    const result = terminal(events);

    // 1M input tokens @ $1/MTok = $1.00; 0.5M output tokens @ $2/MTok = $1.00 → total $2.00
    expect(result.cost).toBeDefined();
    expect(result.cost?.usd).toBeCloseTo(2.0, 4);
  });

  it("terminal result.cost.usd reflects multi-turn spend", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "noop", {})], usage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
      { content: [textBlock("done")], usage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [noop],
      modelId: "test-model",
      prices: {
        "test-model": { inputPerMTok: 1.0, outputPerMTok: 2.0 },
      },
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-usd-multi" }));
    const result = terminal(events);

    // 2 turns: (2M input @ $1 + 1M output @ $2) = $2 + $2 = $4
    expect(result.cost?.usd).toBeCloseTo(4.0, 4);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: resume terminal fast-path passes budget → child USD is included
// ---------------------------------------------------------------------------

import { resumeTurn } from "../src/loop.js";
import { Session } from "../src/session.js";
import { ToolRegistry } from "../src/tool.js";

describe("Fix 5 — resume terminal fast-path includes child (tree) cost", () => {
  it("resumed already-terminated session preserves its original cost snapshot", async () => {
    const store = await freshStore();
    // Set up a completed session: user → assistant (no tool uses)
    const model = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
    const idGen = ((n: number) => () => `e${n++}`)(0);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelId: "test-model",
      prices: { "test-model": { inputPerMTok: 1.0, outputPerMTok: 2.0 } },
      now: () => "t",
      newId: idGen,
    });

    // Run first to create a completed session
    await collect(agent.query("hello", { sessionId: "s-resume-cost" }));

    // Now resume the already-completed session with a child budget (simulates subagent spend)
    const registry = new ToolRegistry([]);
    const session = await Session.open(store, {
      sessionId: "s-resume-cost",
      agentId: "a",
      now: () => "t",
      newId: ((n: number) => () => `re${n++}`)(0),
    });

    const childBudget = { usage: { inputTokens: 500_000, outputTokens: 200_000 }, usd: 0.9 };

    const events: StreamEvent[] = [];
    for await (const e of resumeTurn({
      agentId: "a",
      instructions: "",
      input: "",
      model,
      registry,
      session,
      scope: { kind: "agent", agentId: "a" },
      store,
      maxTurns: 8,
      modelId: "test-model",
      prices: { "test-model": { inputPerMTok: 1.0, outputPerMTok: 2.0 } },
      budget: childBudget,
    })) {
      events.push(e);
    }

    const result = terminal(events);
    expect(result.subtype).toBe("success");

    // A completed run's persisted result is immutable. A new caller-side budget supplied only
    // during replay must not rewrite the historical cost or child usage.
    expect(result.cost).toBeDefined();
    expect(result.cost!.usd).toBeCloseTo(0.0002);
    expect(result.cost!.children).toBeUndefined();
  });

  it("resume no-events path also passes budget (early error path)", async () => {
    const store = await freshStore();
    // Create a session with NO events by opening a non-existent session
    const model = new MockModel([]);
    const registry = new ToolRegistry([]);
    const session = await Session.open(store, {
      sessionId: "s-empty-resume",
      agentId: "a-empty",
      now: () => "t",
      newId: ((n: number) => () => `em${n++}`)(0),
    });

    const childBudget = { usage: { inputTokens: 1000, outputTokens: 500 }, usd: 0.5 };

    const events: StreamEvent[] = [];
    for await (const e of resumeTurn({
      agentId: "a-empty",
      instructions: "",
      input: "",
      model,
      registry,
      session,
      scope: { kind: "agent", agentId: "a-empty" },
      store,
      maxTurns: 8,
      modelId: "test-model",
      prices: { "test-model": { inputPerMTok: 1.0, outputPerMTok: 2.0 } },
      budget: childBudget,
    })) {
      events.push(e);
    }

    const result = terminal(events);
    expect(result.subtype).toBe("error"); // no events → error
    // Even on the error path, child cost should be reflected
    expect(result.cost!.usd).toBeGreaterThanOrEqual(0.5);
  });
});
