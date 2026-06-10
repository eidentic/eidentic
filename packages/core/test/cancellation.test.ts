/**
 * §16.4 — Cooperative query cancellation tests.
 *
 * Strategy: abort signals are triggered at deterministic points:
 *  - pre-abort: controller.abort() called BEFORE agent.query()
 *  - tool-abort: a tool's execute() calls controller.abort() then returns, so the
 *    post-tool-batch boundary check fires on the very next tick.
 *
 * No real model calls; every run uses MockModel or a custom scripted model.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.at(-1);
  if (!t || t.type !== "result") throw new Error("last event is not a result");
  return t as Extract<StreamEvent, { type: "result" }>;
}

async function freshStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

describe("§16.4 cancellation: abort BEFORE run starts", () => {
  it("pre-aborted signal → immediate aborted result; no model call", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [textBlock("should not see this")], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const controller = new AbortController();
    controller.abort(); // abort BEFORE the run

    const events = await collect(agent.query("hello", { sessionId: "s1", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    expect(model.calls).toHaveLength(0); // no model call made
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("§16.4 cancellation: abort after first turn", () => {
  it("abort triggered from a tool → aborted result with partial usage (> 0)", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    // A tool that aborts the controller when executed. The loop sees the abort
    // at the post-tool-batch boundary check and emits an aborted terminal.
    const abortingTool = createTool({
      id: "aborter",
      description: "aborts the run",
      inputSchema: z.object({}),
      execute: async () => {
        controller.abort();
        return { aborted: true };
      },
    });

    // Turn 1: use the aborting tool. Turn 2 (would be): finish — but abort fires first.
    const model = new MockModel([
      { content: [toolUseBlock("c1", "aborter", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done (should not see)")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [abortingTool],
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s2", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    // Partial usage from the first model call must be present.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    // The loop must NOT have run a second turn — only 1 model call.
    expect(model.calls).toHaveLength(1);
  });
});

describe("§16.4 cancellation: durable — checkpoint written on abort", () => {
  it("aborting a durable run writes a checkpoint to the store", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    const abortingTool = createTool({
      id: "aborter",
      description: "aborts the run",
      inputSchema: z.object({}),
      execute: async () => {
        controller.abort();
        return { done: true };
      },
    });

    const model = new MockModel([
      { content: [toolUseBlock("c1", "aborter", {})], usage: { inputTokens: 3, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [abortingTool],
      durable: true,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    await collect(agent.query("go", { sessionId: "s3", signal: controller.signal }));

    // A checkpoint must have been written for the aborted session.
    const checkpoint = await store.lastCheckpoint("s3");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.sessionId).toBe("s3");
  });
});

describe("§16.4 cancellation: child teardown", () => {
  it("aborting the parent signal propagates to child agents", async () => {
    const controller = new AbortController();

    // The child will be scripted but its run should abort before it returns a result
    // because the parent aborts via the aborting tool BEFORE invoking the child.
    const parentStore = await freshStore();
    const childStore = await freshStore();

    let childModelCalls = 0;

    // Child: scripted to return a response — but won't be called if the abort fires before spawn.
    const childModel = new MockModel([
      { content: [textBlock("child result")], usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
    // Intercept calls to count them.
    const originalComplete = childModel.complete.bind(childModel);
    (childModel as { complete: typeof childModel.complete }).complete = async (req) => {
      childModelCalls++;
      return originalComplete(req);
    };

    const child = new Agent({
      id: "child",
      instructions: "do stuff",
      model: childModel,
      store: childStore,
      now: () => "tc",
      newId: ((n) => () => `ec${n++}`)(0),
    });

    const abortingTool = createTool({
      id: "aborter",
      description: "aborts the run before child is called",
      inputSchema: z.object({}),
      execute: async () => {
        controller.abort();
        return { done: true };
      },
    });

    // Parent: first call the aborting tool (which aborts the signal), then would spawn the child.
    // The abort fires after the tool batch, so the spawn_agent never executes.
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "aborter", {})], usage: { inputTokens: 3, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "spawn_agent", { agent: "child", input: "go" })], usage: { inputTokens: 3, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);

    const parent = new Agent({
      id: "parent",
      instructions: "",
      model: parentModel,
      store: parentStore,
      tools: [abortingTool],
      subAgents: {
        child: { agent: child, description: "does child work" },
      },
      now: () => "tp",
      newId: ((n) => () => `ep${n++}`)(0),
    });

    const events = await collect(parent.query("start", { sessionId: "s4", signal: controller.signal }));
    const result = terminal(events);
    // Parent should have aborted.
    expect(result.subtype).toBe("aborted");
    // Child model should NOT have been called (abort fired before spawn).
    expect(childModelCalls).toBe(0);
  });

  it("signal is threaded into child: a pre-aborted signal stops the child too", async () => {
    const parentStore = await freshStore();
    const childStore = await freshStore();

    let childModelCalls = 0;
    const childModel = new MockModel([
      { content: [textBlock("child says hi")], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    const originalComplete = childModel.complete.bind(childModel);
    (childModel as { complete: typeof childModel.complete }).complete = async (req) => {
      childModelCalls++;
      return originalComplete(req);
    };

    const child = new Agent({
      id: "child",
      instructions: "help",
      model: childModel,
      store: childStore,
      now: () => "tc",
      newId: ((n) => () => `ec${n++}`)(0),
    });

    // Parent immediately spawns the child.
    const parentModel = new MockModel([
      { content: [toolUseBlock("c1", "spawn_agent", { agent: "child", input: "do work" })], usage: { inputTokens: 3, outputTokens: 1 } },
      { content: [textBlock("synthesized")], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);

    const parent = new Agent({
      id: "parent",
      instructions: "",
      model: parentModel,
      store: parentStore,
      subAgents: {
        child: { agent: child, description: "does work" },
      },
      now: () => "tp",
      newId: ((n) => () => `ep${n++}`)(0),
    });

    // Pre-abort: the parent's loop hits the boundary before the first model call,
    // so spawn_agent never fires and child model is never called.
    const controller = new AbortController();
    controller.abort();

    const events = await collect(parent.query("go", { sessionId: "s5", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    expect(childModelCalls).toBe(0);
  });
});

describe("§16.4 cancellation: no-signal path unchanged", () => {
  it("a run with no signal completes successfully (byte-identical to old behavior)", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [textBlock("all good")], usage: { inputTokens: 3, outputTokens: 2 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("hello", { sessionId: "s6" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect(result.output).toBe("all good");
  });
});
