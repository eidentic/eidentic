import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { createTool } from "../src/tool.js";
import { Agent } from "../src/agent.js";
import { Memory } from "@eidentic/memory";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pingTool = createTool({
  id: "ping",
  description: "Ping the server.",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

function makeStore() {
  const store = new InMemoryStore();
  // InMemoryStore.migrate is async but sync-compatible for construction
  return store;
}

// ---------------------------------------------------------------------------
// Agent.toolSchemas()
// ---------------------------------------------------------------------------

describe("Agent.toolSchemas()", () => {
  it("returns [] for a plain agent with no tools", async () => {
    const store = makeStore();
    await store.migrate();
    const agent = new Agent({
      id: "plain",
      instructions: "plain",
      model: new MockModel([]),
      store,
    });
    const schemas = agent.toolSchemas();
    expect(schemas).toEqual([]);
  });

  it("returns configured tools for a basic agent", async () => {
    const store = makeStore();
    await store.migrate();
    const agent = new Agent({
      id: "basic",
      instructions: "basic",
      model: new MockModel([]),
      store,
      tools: [pingTool],
    });
    const schemas = agent.toolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("ping");
    expect(schemas[0]!.description).toBe("Ping the server.");
  });

  it("includes memory_* tools for an agent with editable memory", async () => {
    const store = makeStore();
    await store.migrate();
    const memory = new Memory({
      store,
      blocks: { human: { value: "", description: "user info", limit: 500 } },
    });
    const agent = new Agent({
      id: "mem",
      instructions: "mem",
      model: new MockModel([]),
      store,
      memory,
    });
    const schemas = agent.toolSchemas();
    const names = schemas.map((s) => s.name);
    // memory tools should be present
    expect(names.some((n) => n.startsWith("memory_"))).toBe(true);
  });

  it("includes graph_* tools when memory has a graph", async () => {
    const store = makeStore();
    await store.migrate();
    const memory = new Memory({
      store,
      graph: store,
      blocks: { human: { value: "", description: "user info", limit: 500 } },
    });
    const agent = new Agent({
      id: "graph",
      instructions: "graph",
      model: new MockModel([]),
      store,
      memory,
    });
    const schemas = agent.toolSchemas();
    const names = schemas.map((s) => s.name);
    expect(names.some((n) => n.startsWith("graph_"))).toBe(true);
  });

  it("includes both config tools and auto-added groups", async () => {
    const store = makeStore();
    await store.migrate();
    const memory = new Memory({
      store,
      blocks: { human: { value: "", description: "user info", limit: 500 } },
    });
    const agent = new Agent({
      id: "combo",
      instructions: "combo",
      model: new MockModel([]),
      store,
      tools: [pingTool],
      memory,
    });
    const schemas = agent.toolSchemas();
    const names = schemas.map((s) => s.name);
    expect(names).toContain("ping");
    expect(names.some((n) => n.startsWith("memory_"))).toBe(true);
  });

  it("returns the same result on successive calls (stable, no mutation)", async () => {
    const store = makeStore();
    await store.migrate();
    const agent = new Agent({
      id: "stable",
      instructions: "stable",
      model: new MockModel([]),
      store,
      tools: [pingTool],
    });
    const first = agent.toolSchemas();
    const second = agent.toolSchemas();
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Agent.modelId accessor
// ---------------------------------------------------------------------------

describe("Agent.modelId", () => {
  it("returns undefined when neither modelId nor model.modelId is set", async () => {
    const store = makeStore();
    await store.migrate();
    // MockModel has no modelId by default
    const agent = new Agent({
      id: "a",
      instructions: "",
      model: new MockModel([]),
      store,
    });
    // MockModel.modelId is undefined by default
    expect(agent.modelId).toBeUndefined();
  });

  it("returns config.modelId when explicitly set", async () => {
    const store = makeStore();
    await store.migrate();
    const agent = new Agent({
      id: "a",
      instructions: "",
      model: new MockModel([]),
      store,
      modelId: "claude-sonnet-4-5",
    });
    expect(agent.modelId).toBe("claude-sonnet-4-5");
  });
});

// ---------------------------------------------------------------------------
// Agent.instructions accessor
// ---------------------------------------------------------------------------

describe("Agent.instructions", () => {
  it("returns the configured instructions string", async () => {
    const store = makeStore();
    await store.migrate();
    const agent = new Agent({
      id: "a",
      instructions: "You are a helpful assistant.",
      model: new MockModel([]),
      store,
    });
    expect(agent.instructions).toBe("You are a helpful assistant.");
  });
});
