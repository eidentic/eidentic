import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent, type CostBreakdown, type CostThresholdInfo } from "@eidentic/types";
import { createTool, ToolRegistry } from "../src/tool.js";
import { Session } from "../src/session.js";
import { runTurn, resumeTurn, type RunTurnArgs } from "../src/loop.js";

const ping = createTool({ id: "ping", description: "pong", inputSchema: z.object({}), execute: async () => ({ reply: "pong" }) });

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function deps(n = 0) {
  let i = n;
  return { now: () => "t", newId: () => `id${i++}` };
}

const result = (events: StreamEvent[]) => events.at(-1) as Extract<StreamEvent, { type: "result" }>;

describe("cost governor", () => {
  it("aborts with max_tokens when accumulated tokens reach the ceiling (preflight, before the next call)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // First call uses 60 in + 0 out = 60 tokens; ceiling is 50 → the SECOND preflight aborts.
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 60, outputTokens: 0 } },
      { content: [textBlock("never reached")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, policy: { maxTokens: 50 },
    }));
    const r = result(events);
    expect(r.subtype).toBe("max_tokens");
    expect(r.cost!.foreground).toEqual({ inputTokens: 60, outputTokens: 0 });
    expect(r.cost!.background).toEqual({ inputTokens: 0, outputTokens: 0 });
    // model was called exactly once (the second preflight aborted before the 2nd call)
    expect((model as MockModel).calls.length).toBe(1);
  });

  it("aborts with max_cost when usd from prices reaches maxCostUsd", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // 1,000,000 input tokens @ $1/MTok = $1.00 after the first call; ceiling $0.50 → 2nd preflight aborts.
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, modelId: "haiku",
      policy: { maxCostUsd: 0.5 }, prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
    }));
    const r = result(events);
    expect(r.subtype).toBe("max_cost");
    expect(r.cost!.usd).toBeCloseTo(1.0, 6);
  });

  it("aborts with max_wall_clock when elapsed >= maxWallClockMs using the injected monotonic clock", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // clock advances 100ms per read; first preflight reads t=0, after one call the 2nd preflight reads >=200ms.
    let ticks = 0;
    const monotonicNow = () => (ticks++) * 100;
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, monotonicNow, policy: { maxWallClockMs: 150 },
    }));
    expect(result(events).subtype).toBe("max_wall_clock");
  });

  it("legacy maxTurns still aborts with max_turns and now carries a CostBreakdown", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 2, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "ping", {})], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 1,
    }));
    const r = result(events);
    expect(r.subtype).toBe("max_turns");
    expect(r.cost!.foreground).toEqual({ inputTokens: 2, outputTokens: 1 });
  });

  it("policy.maxTurns overrides the legacy maxTurns arg", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 1, policy: { maxTurns: 16 }, // policy wins → run completes instead of max_turns
    }));
    expect(result(events).subtype).toBe("success");
  });

  it("fires onCostThreshold exactly once when softCostUsd is crossed; does NOT abort", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const onCostThreshold = vi.fn<(info: CostThresholdInfo) => void>();
    // each call: 500_000 in @ $1/MTok = $0.50/call. soft cap $0.40 crossed after call 1; stays crossed.
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 500_000, outputTokens: 0 } },
      { content: [toolUseBlock("c2", "ping", {})], usage: { inputTokens: 500_000, outputTokens: 0 } },
      { content: [textBlock("done")], usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, modelId: "haiku",
      policy: { softCostUsd: 0.4 }, prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
      onCostThreshold,
    }));
    expect(result(events).subtype).toBe("success");
    expect(onCostThreshold).toHaveBeenCalledTimes(1);
    expect(onCostThreshold.mock.calls[0]![0].usd).toBeCloseTo(0.5, 6);
  });

  it("no-policy run: terminal success carries a CostBreakdown but is otherwise unchanged", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi back")], usage: { inputTokens: 4, outputTokens: 2 } }]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16,
    }));
    const r = result(events);
    expect(r.subtype).toBe("success");
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
    const cost: CostBreakdown = r.cost!;
    expect(cost.foreground).toEqual({ inputTokens: 4, outputTokens: 2 });
    expect(cost.background).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(cost.cachedInputTokens).toBe(0);
    expect(cost.usd).toBeUndefined(); // no prices → no usd
  });

  it("error path also carries a CostBreakdown", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([]); // empty script → first complete() throws
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });
    const events = await collect(runTurn({
      agentId: "a1", instructions: "x", input: "hi", model,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16,
    }));
    const r = result(events);
    expect(r.subtype).toBe("error");
    expect(r.cost).toBeDefined();
    expect(r.cost!.foreground).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("Fix 1 — resume carries over prior cost/token budget", () => {
  it("aborts after one resumed model call when persisted events already consumed most of the budget", async () => {
    // Seed the session with a persisted assistant event totalling 40 input tokens.
    const store = new InMemoryStore();
    await store.migrate();

    // First run: produce 40 input tokens in one call, end with a tool-use so the session is non-terminal.
    const firstModel = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 40, outputTokens: 0 } },
      // Model script intentionally exhausted here; resume will use the second model.
    ]);
    const session = await Session.open(store, { sessionId: "resume-budget", agentId: "a1", now: () => "t", newId: ((n) => () => `id${n++}`)(10) });
    // Run the first turn; it will get an error when the model runs out of scripted responses — that's fine,
    // we only care that the assistant event (40 tokens) was persisted before the crash.
    const firstEvents: StreamEvent[] = [];
    for await (const e of runTurn({
      agentId: "a1", instructions: "x", input: "go", model: firstModel,
      registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, // no policy here — budget will be enforced on resume
    })) firstEvents.push(e);

    // Confirm the assistant event with 40 tokens was persisted.
    const storedEvents = await store.readEvents("resume-budget");
    const assistantEvents = storedEvents.filter(e => e.kind === "assistant");
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1);
    expect(assistantEvents[0]!.meta?.usage).toEqual({ inputTokens: 40, outputTokens: 0 });

    // Now open a new session handle (simulating a resumed process) and resume with maxTokens: 50.
    // The priorUsage is 40 tokens. A single model call of ≥11 tokens pushes total past 50.
    const resumeModel = new MockModel([
      { content: [textBlock("done after resume")], usage: { inputTokens: 15, outputTokens: 0 } },
    ]);
    const resumeSession = await Session.open(store, { sessionId: "resume-budget", agentId: "a1", now: () => "t", newId: ((n) => () => `rid${n++}`)(0) });
    const resumedEvents: StreamEvent[] = [];
    for await (const e of resumeTurn({
      agentId: "a1", instructions: "x", input: "go", model: resumeModel,
      registry: new ToolRegistry([ping]), session: resumeSession, scope: { kind: "agent", agentId: "a1" },
      store, maxTurns: 16, policy: { maxTokens: 50 },
    })) resumedEvents.push(e);

    // The resumed run should have been cut off: priorUsage=40 + response=15 = 55 > 50.
    const r = result(resumedEvents);
    expect(r.subtype).toBe("max_tokens");
    // The reported usage must include the prior 40 tokens, not just the 15 from this run.
    expect(r.usage.inputTokens).toBeGreaterThanOrEqual(50);
    expect(r.cost!.foreground.inputTokens).toBeGreaterThanOrEqual(50);
  });
});

describe("Fix 2 — warn when USD ceiling set without prices+modelId", () => {
  it("emits a warn through the logger when maxCostUsd is set but prices/modelId are absent", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const session = await Session.open(store, { sessionId: "warn-test-1", agentId: "a1", now: () => "t", newId: ((n) => () => `w${n++}`)(0) });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await collect(runTurn({
        agentId: "a1", instructions: "x", input: "hi", model,
        registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
        store, maxTurns: 16, policy: { maxCostUsd: 0.5 },
        // No prices/modelId → ceiling can never fire; logger routes warn to stderr (console.error)
      }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/maxCostUsd.*prices\+modelId|prices\+modelId.*maxCostUsd/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT warn when prices+modelId are both provided alongside maxCostUsd", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const session = await Session.open(store, { sessionId: "warn-test-2", agentId: "a1", now: () => "t", newId: ((n) => () => `v${n++}`)(0) });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await collect(runTurn({
        agentId: "a1", instructions: "x", input: "hi", model,
        registry: new ToolRegistry([ping]), session, scope: { kind: "agent", agentId: "a1" },
        store, maxTurns: 16,
        modelId: "haiku", prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
        policy: { maxCostUsd: 100 },
      }));
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
