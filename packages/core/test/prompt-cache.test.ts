/**
 * Tests for D6: prompt caching (AgentConfig.promptCache → ModelRequest.cacheControl).
 *
 * Verifies:
 *  - With promptCache: true, the model is called with cacheControl: true on every turn.
 *  - With promptCache omitted (default off), cacheControl is absent → byte-identical requests.
 *  - The flag is threaded through runTurn (RunTurnArgs.promptCache → ModelRequest.cacheControl).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, type ModelRequest, type StreamEvent } from "@eidentic/types";
import { createTool, ToolRegistry } from "../src/tool.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/loop.js";
import { Agent } from "../src/agent.js";

function deps(n = 0) {
  let i = n;
  return { now: () => "t", newId: () => `id${i++}` };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const noop = createTool({
  id: "noop",
  description: "noop",
  inputSchema: z.object({}),
  execute: async () => ({}),
});

// --- runTurn-level tests (RunTurnArgs.promptCache) ---

describe("runTurn — promptCache flag → ModelRequest.cacheControl", () => {
  it("promptCache: true → model is called with cacheControl: true", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 10, outputTokens: 5 } }]);
    const session = await Session.open(store, { sessionId: "s1", agentId: "a1", ...deps() });

    await collect(
      runTurn({
        agentId: "a1",
        instructions: "be helpful",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        promptCache: true,
      }),
    );

    expect(model.calls.length).toBeGreaterThan(0);
    const req = model.calls[0] as ModelRequest;
    expect(req.cacheControl).toBe(true);
  });

  it("promptCache omitted → cacheControl is undefined (back-compat)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 10, outputTokens: 5 } }]);
    const session = await Session.open(store, { sessionId: "s2", agentId: "a1", ...deps() });

    await collect(
      runTurn({
        agentId: "a1",
        instructions: "be helpful",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        // promptCache deliberately omitted
      }),
    );

    const req = model.calls[0] as ModelRequest;
    expect(req.cacheControl).toBeUndefined();
  });

  it("promptCache: false → cacheControl is absent (back-compat)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 10, outputTokens: 5 } }]);
    const session = await Session.open(store, { sessionId: "s3", agentId: "a1", ...deps() });

    await collect(
      runTurn({
        agentId: "a1",
        instructions: "be helpful",
        input: "hi",
        model,
        registry: new ToolRegistry([noop]),
        session,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 16,
        promptCache: false,
      }),
    );

    const req = model.calls[0] as ModelRequest;
    // promptCache: false produces cacheControlArg = {} so cacheControl is not set
    expect(req.cacheControl).toBeUndefined();
  });
});

// --- Agent-level tests (AgentConfig.promptCache) ---

describe("Agent — promptCache config → model receives cacheControl", () => {
  it("AgentConfig.promptCache: true → model called with cacheControl: true", async () => {
    const store = new InMemoryStore();
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 20, outputTokens: 8 } }]);

    const agent = new Agent({
      id: "agent-cache",
      instructions: "be helpful",
      model,
      store,
      promptCache: true,
      ...deps(),
    });

    await collect(agent.query("hello", { sessionId: "sc1" }));

    expect(model.calls.length).toBeGreaterThan(0);
    const req = model.calls[0] as ModelRequest;
    expect(req.cacheControl).toBe(true);
  });

  it("AgentConfig.promptCache absent → cacheControl absent (back-compat, byte-identical requests)", async () => {
    const store = new InMemoryStore();
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 20, outputTokens: 8 } }]);

    const agent = new Agent({
      id: "agent-no-cache",
      instructions: "be helpful",
      model,
      store,
      // promptCache deliberately omitted
      ...deps(),
    });

    await collect(agent.query("hello", { sessionId: "sc2" }));

    const req = model.calls[0] as ModelRequest;
    expect(req.cacheControl).toBeUndefined();
  });
});
