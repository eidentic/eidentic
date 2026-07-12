import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MapSecrets, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { createTool } from "../src/tool.js";
import { Agent } from "../src/agent.js";
import type { PermissionPolicy } from "@eidentic/types";

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

// ─── tools ────────────────────────────────────────────────────────────────────

const safeTool = createTool({
  id: "safe_op", description: "a safe operation", sideEffect: "read-only",
  inputSchema: z.object({}),
  execute: async () => ({ result: "safe" }),
});

const dangerTool = createTool({
  id: "danger_rm", description: "a dangerous deletion", sideEffect: "destructive",
  inputSchema: z.object({}),
  execute: async () => ({ result: "danger" }),
});

const dangerWrite = createTool({
  id: "danger_write", description: "a dangerous write", sideEffect: "destructive",
  inputSchema: z.object({}),
  execute: async () => ({ result: "danger_write" }),
});

// ─── agent schema filtering ───────────────────────────────────────────────────

describe("Agent schema filtering with permissions", () => {
  it("denied tools are NOT in the model's tool schema (model never sees them)", async () => {
    const store = new InMemoryStore(); await store.migrate();
    // Model just responds with text immediately (no tool calls)
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]);

    const permissions: PermissionPolicy = { deny: ["danger_*"] };
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [safeTool, dangerTool, dangerWrite],
      permissions,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    await run(agent, "hello", "s1");

    // MockModel records the request; check the tools list
    const toolsInSchema = model.calls[0]!.tools.map((t) => t.name);
    expect(toolsInSchema).toContain("safe_op");
    expect(toolsInSchema).not.toContain("danger_rm");
    expect(toolsInSchema).not.toContain("danger_write");
  });

  it("allowed tools are present in the model's tool schema", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]);

    const permissions: PermissionPolicy = { deny: ["danger_*"] };
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [safeTool, dangerTool],
      permissions,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    await run(agent, "hello", "s1");
    const toolsInSchema = model.calls[0]!.tools.map((t) => t.name);
    expect(toolsInSchema).toContain("safe_op");
  });

  it("no permissions config keeps tools discoverable but gates mutating dispatch", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "danger_rm", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [safeTool, dangerTool],
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "hello", "s1");
    const toolsInSchema = model.calls[0]!.tools.map((t) => t.name);
    expect(toolsInSchema).toContain("safe_op");
    expect(toolsInSchema).toContain("danger_rm");
    const result = events.find((event) => event.type === "tool.result" && event.toolName === "danger_rm");
    expect(result?.isError).toBe(true);
    expect((result?.output as { error?: string })?.error).toMatch(/permission denied/i);
  });

  it("denied tool attempted at dispatch still returns permission-denied (defense in depth)", async () => {
    const store = new InMemoryStore(); await store.migrate();

    // Model tries to call danger_rm even though it's not in the schema
    const model = new MockModel([
      { content: [toolUseBlock("c1", "danger_rm", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const permissions: PermissionPolicy = { deny: ["danger_*"] };
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [safeTool, dangerTool],
      permissions,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "hello", "s1");
    // The tool.result event should reflect an error (permission denied OR unknown tool — either is correct)
    const toolResultEvent = events.find((e) => e.type === "tool.result");
    expect(toolResultEvent?.isError).toBe(true);
  });
});

// ─── Fix 1: live permission-mode change ──────────────────────────────────────

describe("Fix 1 — Agent.setPermissionMode live mode change", () => {
  it("calling setPermissionMode('plan') before query filters non-read-only tools from model schema", async () => {
    const store = new InMemoryStore(); await store.migrate();

    // Model just returns text (no tool calls needed for this test — we just inspect the schema)
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]);

    const agent = new Agent({
      id: "a", instructions: "", model, store,
      // Start with no restriction (default mode)
      tools: [safeTool, dangerTool, dangerWrite],
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    // Change to plan mode between turns
    agent.setPermissionMode("plan");

    // Next query should see only read-only tools in the schema
    await run(agent, "hello", "s-mode-change");

    const toolsInSchema = model.calls[0]!.tools.map((t) => t.name);
    // safeTool is read-only → must appear
    expect(toolsInSchema).toContain("safe_op");
    // dangerTool and dangerWrite are destructive → plan mode must exclude them
    expect(toolsInSchema).not.toContain("danger_rm");
    expect(toolsInSchema).not.toContain("danger_write");
  });

  it("setPermissionMode can be called multiple times; latest mode applies on the next query", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([
      { content: [textBlock("first")], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("second")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "b", instructions: "", model, store,
      tools: [safeTool, dangerTool],
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    // First query with default (no restrictions) — both tools in schema
    agent.setPermissionMode("default");
    await run(agent, "q1", "s-mode-multi");
    expect(model.calls[0]!.tools.map((t) => t.name)).toContain("danger_rm");

    // Switch to plan for the second query — non-read-only filtered
    agent.setPermissionMode("plan");
    await run(agent, "q2", "s-mode-multi-2");
    expect(model.calls[1]!.tools.map((t) => t.name)).not.toContain("danger_rm");
    expect(model.calls[1]!.tools.map((t) => t.name)).toContain("safe_op");
  });
});

// ─── Fix 4: ctx.signal threading ─────────────────────────────────────────────

describe("Fix 4 — ctx.signal threading", () => {
  it("passing a signal in QueryOptions makes ctx.signal === that signal inside a tool execute", async () => {
    let capturedSignal: AbortSignal | undefined;

    const signalTool = createTool({
      id: "signal_check", description: "captures ctx.signal", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => { capturedSignal = ctx?.signal; return {}; },
    });

    const store = new InMemoryStore(); await store.migrate();
    const controller = new AbortController();
    const signal = controller.signal;

    // Model calls signal_check then returns text
    const model = new MockModel([
      { content: [toolUseBlock("c1", "signal_check", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [signalTool],
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("go", { sessionId: "sig-test", signal })) events.push(e);

    expect(capturedSignal).toBe(signal);
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("without a signal in QueryOptions, ctx.signal is undefined", async () => {
    let capturedSignal: AbortSignal | undefined = "not-undefined" as unknown as AbortSignal;

    const signalTool = createTool({
      id: "signal_check2", description: "captures ctx.signal", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => { capturedSignal = ctx?.signal; return {}; },
    });

    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "signal_check2", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a2", instructions: "", model, store, tools: [signalTool],
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    for await (const _ of agent.query("go", { sessionId: "sig-test2" })) { /* drain */ }
    expect(capturedSignal).toBeUndefined();
  });
});

// ─── EnvSecrets ───────────────────────────────────────────────────────────────

describe("EnvSecrets", () => {
  it("reads only explicitly allowed environment refs", async () => {
    const { EnvSecrets } = await import("../src/index.js");
    const env = new EnvSecrets(["TEST_SECRET_XYZ"], { TEST_SECRET_XYZ: "hello-env", OTHER: "hidden" });
    expect(await env.get("TEST_SECRET_XYZ")).toBe("hello-env");
    await expect(env.get("OTHER")).rejects.toThrow(/not allowed/i);
    await expect(env.get("../INVALID")).rejects.toThrow(/invalid secret ref/i);
  });
});

describe("resolved secret containment", () => {
  it("keeps a buggy tool's returned secret out of events, model messages, and persisted history", async () => {
    const secret = "ordinary-credential-value";
    const store = new InMemoryStore(); await store.migrate();
    const tool = createTool({
      id: "buggy_api", description: "calls an API", requiredSecrets: ["API_KEY"],
      inputSchema: z.object({}),
      execute: async ({ ctx }) => ({ response: await ctx!.secrets!.require("API_KEY") }),
    });
    const model = new MockModel([
      { content: [toolUseBlock("call-1", "buggy_api", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "secret-agent", instructions: "Use the API.", model, store, tools: [tool],
      secrets: new MapSecrets({ API_KEY: secret }),
      now: () => "t", newId: ((n) => () => `secret-${n++}`)(0),
    });

    const events = await run(agent, "go", "secret-containment");
    const persisted = await store.readEvents("secret-containment");
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(model.calls)).not.toContain(secret);
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(events.find((event) => event.type === "tool.result")).toMatchObject({
      output: { response: "[REDACTED_SECRET]" },
    });
  });
});
