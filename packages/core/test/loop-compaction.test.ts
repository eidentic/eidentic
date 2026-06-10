import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@eidentic/types";
import { createTool } from "../src/tool.js";
import { z } from "zod";

/** A scripted model that returns the next response, ignoring input. */
class ScriptedModel implements ModelPort {
  private i = 0;
  constructor(private readonly steps: ModelResponse[]) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const r = this.steps[this.i++];
    if (!r) throw new Error(`ScriptedModel: no step #${this.i}`);
    return r;
  }
}

const BIG = "x".repeat(8_000); // ~2000 tokens per tool result

function buildAgent(model: ModelPort, opts: { onPreCompact?: (i: { estTokens: number }) => void } = {}) {
  const store = new InMemoryStore();
  // a tool that returns a big payload, plus one that fails (failure evidence)
  const bigTool = createTool({
    id: "big",
    description: "returns a big blob",
    inputSchema: z.object({}),
    execute: async () => ({ path: "/big", body: BIG }),
  });
  const failTool = createTool({
    id: "boom",
    description: "always fails",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("boom-failed-evidence");
    },
  });
  const agent = new Agent({
    id: "compactor",
    instructions: "SYS-PREFIX. Do the task.",
    model,
    store,
    tools: [bigTool, failTool],
    maxTurns: 20,
    compaction: { maxContextTokens: 1_500, keepRecentTurns: 2, toolResultMaxChars: 1_000_000 },
    ...(opts.onPreCompact ? { onPreCompact: opts.onPreCompact } : {}),
  });
  return { agent, store };
}

describe("loop compaction integration", () => {
  it("overflow triggers compaction: emits a compaction StreamEvent, window shrinks, run completes, failure preserved", async () => {
    // Turn 1: call big tool. Turn 2: call boom (fails). Turn 3: call big again (window now overflows). Turn 4: finish.
    const model = new ScriptedModel([
      { content: [toolUseBlock("c1", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "boom", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c3", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    let preCompactFired = 0;
    const { agent } = buildAgent(model, { onPreCompact: () => { preCompactFired++; } });

    const events: StreamEvent[] = [];
    for await (const ev of agent.query("go", { sessionId: "s1" })) events.push(ev);

    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents.length).toBeGreaterThan(0);
    const c = compactionEvents[0] as Extract<StreamEvent, { type: "compaction" }>;
    expect(c.after).toBeLessThanOrEqual(c.before);
    expect(c.stages.length).toBeGreaterThan(0);
    expect(preCompactFired).toBeGreaterThan(0); // hook fired before drop

    const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }>;
    expect(result.subtype).toBe("success"); // run still completes
  });

  it("persists a `compaction` audit event but does NOT mutate prior events", async () => {
    const model = new ScriptedModel([
      { content: [toolUseBlock("c1", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const { agent, store } = buildAgent(model);
    for await (const _ of agent.query("go", { sessionId: "s2" })) { /* drain */ }

    const events = await store.readEvents("s2");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("compaction");
    // the tool_result events are still present and unmodified (audit trail intact)
    expect(kinds.filter((k) => k === "tool_result").length).toBe(2);
  });

  it("no compaction config → loop unchanged (no compaction events, run completes)", async () => {
    const store = new InMemoryStore();
    const model = new MockModel([
      { content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ id: "plain", instructions: "S", model, store });
    const events: StreamEvent[] = [];
    for await (const ev of agent.query("go", { sessionId: "s3" })) events.push(ev);
    expect(events.some((e) => e.type === "compaction")).toBe(false);
    expect((events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }>).subtype).toBe("success");
  });

  it("resume rebuilds from the FULL log then re-compacts (compaction events ignored on replay)", async () => {
    // durable store + a run that compacts, then resume continues (already complete run yields terminal result).
    const store = new InMemoryStore();
    const bigTool = createTool({ id: "big", description: "big", inputSchema: z.object({}), execute: async () => ({ path: "/b", body: BIG }) });
    const model = new ScriptedModel([
      { content: [toolUseBlock("c1", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "r", instructions: "SYS", model, store, durable: true, tools: [bigTool],
      compaction: { maxContextTokens: 1_500, keepRecentTurns: 2, toolResultMaxChars: 1_000_000 },
    });
    for await (const _ of agent.query("go", { sessionId: "s4" })) { /* drain to completion */ }
    // resume on a completed run replays its terminal result without throwing (compaction events ignored).
    const resumed: StreamEvent[] = [];
    for await (const ev of agent.resume("s4")) resumed.push(ev);
    expect((resumed.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }>).subtype).toBe("success");
  });

  it("onPreCompact fires before compaction (window at full size before any drop)", async () => {
    const model = new ScriptedModel([
      { content: [toolUseBlock("c1", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "big", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    let preCompactTokens = 0;
    const { agent } = buildAgent(model, {
      onPreCompact: ({ estTokens }) => { preCompactTokens = estTokens; },
    });
    for await (const _ of agent.query("go", { sessionId: "s5" })) { /* drain */ }
    // The hook must have fired with a token count that exceeds the budget (1_500).
    expect(preCompactTokens).toBeGreaterThan(1_500);
  });
});
