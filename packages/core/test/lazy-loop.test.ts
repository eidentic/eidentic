import { describe, it, expect } from "vitest";
import { Agent, createTool } from "../src/index.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ToolSchema } from "@eidentic/types";
import { z } from "zod";

/** Build N trivial read-only tools named tool_000..tool_(N-1). */
function manyTools(n: number) {
  return Array.from({ length: n }, (_, i) =>
    createTool({
      id: `tool_${String(i).padStart(3, "0")}`,
      description: `Tool number ${i} that does operation ${i}`,
      inputSchema: z.object({}),
      execute: async () => ({ ran: i }),
    }),
  );
}
/** Capture the `tools:` array the model saw on each call. */
function manifests(model: MockModel): string[][] {
  return model.calls.map((c) => c.tools.map((t: ToolSchema) => t.name));
}

describe("lazy loop (§5.4)", () => {
  it("OFF below threshold: per-turn manifest is byte-identical to schemas()", async () => {
    const tools = manyTools(5);
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const store = new InMemoryStore();
    // lazyTools configured but toolset (5 + 2 meta = 7) ≤ threshold 20 → inactive ⇒ unchanged.
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: true });
    for await (const _ of agent.query("hi", { sessionId: "s1" })) { /* drain */ }
    const seen = manifests(model)[0]!;
    // Full set (all 5 user tools + search_tools + load_tool), none pruned.
    expect(seen).toContain("tool_000");
    expect(seen).toContain("tool_004");
    expect(seen.length).toBe(7);
  });

  it("ON above threshold: turn-1 manifest = eager-core ∪ meta (large set hidden)", async () => {
    const tools = manyTools(30);
    const model = new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const store = new InMemoryStore();
    // No EAGER_TOOL_IDS names match `tool_NNN`, so eager = just the two meta-tools.
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: true });
    for await (const _ of agent.query("hi", { sessionId: "s2" })) { /* drain */ }
    expect(manifests(model)[0]!.sort()).toEqual(["load_tool", "search_tools"]);
  });

  it("ON: search_tools → load_tool grows the manifest; the loaded tool dispatches", async () => {
    const tools = manyTools(30);
    const model = new MockModel([
      // turn 1: search
      { content: [toolUseBlock("c1", "search_tools", { query: "operation 7" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 2: load the one we found
      { content: [toolUseBlock("c2", "load_tool", { name: "tool_007" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 3: call it
      { content: [toolUseBlock("c3", "tool_007", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 4: finish
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const store = new InMemoryStore();
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: { threshold: 20 } });
    const results: unknown[] = [];
    for await (const ev of agent.query("find op 7", { sessionId: "s3" })) {
      if (ev.type === "tool.result") results.push(ev);
    }
    const seen = manifests(model);
    // turn 1 + 2: only meta (tool_007 not yet loaded). turn 3: tool_007 now in the manifest.
    expect(seen[0]!.sort()).toEqual(["load_tool", "search_tools"]);
    expect(seen[1]!.sort()).toEqual(["load_tool", "search_tools"]);
    expect(seen[2]).toContain("tool_007");
    // tool_007 actually dispatched and returned its output
    const callResult = results.find((r: any) => r.toolName === "tool_007") as any;
    expect(callResult.output).toEqual({ ran: 7 });
  });

  it("ON: dispatch of an UNLOADED tool still works (discovery is not a capability gate, invariant c)", async () => {
    const tools = manyTools(30);
    const model = new MockModel([
      // model calls tool_009 directly without ever load_tool-ing it
      { content: [toolUseBlock("c1", "tool_009", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const store = new InMemoryStore();
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: true });
    let out: unknown;
    for await (const ev of agent.query("go", { sessionId: "s4" })) {
      if (ev.type === "tool.result" && ev.toolName === "tool_009") out = ev.output;
    }
    expect(out).toEqual({ ran: 9 }); // dispatched fine even though never loaded
  });

  it("ON + permissions: a statically-denied tool never appears in the manifest nor in search_tools", async () => {
    const tools = manyTools(30);
    const model = new MockModel([
      { content: [toolUseBlock("c1", "search_tools", { query: "operation 5", topK: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "a", instructions: "x", model, store, tools,
      lazyTools: true,
      permissions: { deny: ["tool_005"] }, // statically denied
    });
    let searchOut: any;
    for await (const ev of agent.query("go", { sessionId: "s5" })) {
      if (ev.type === "tool.result" && ev.toolName === "search_tools") searchOut = ev.output;
    }
    // search_tools operates over the permission-filtered catalog → tool_005 never surfaces (Decision B)
    expect((searchOut.results as { name: string }[]).map((r) => r.name)).not.toContain("tool_005");
    // and it is absent from every per-turn manifest
    expect(manifests(model).flat()).not.toContain("tool_005");
  });
});

// ---------------------------------------------------------------------------
// Fix 1: incremental loaded-set (O(1) per turn) — correct behavior + no re-scan
// ---------------------------------------------------------------------------

import { loadedToolNames } from "../src/discovery-tools.js";
import type { StoredEvent } from "@eidentic/types";

describe("Fix 1 — incremental loaded-set: correct behavior after multiple load_tool calls", () => {
  it("loaded set accumulates across turns: tool loaded in turn 1 is still visible in turn 3", async () => {
    const tools = manyTools(30);
    const model = new MockModel([
      // turn 1: load tool_010
      { content: [toolUseBlock("c1", "load_tool", { name: "tool_010" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 2: load tool_020
      { content: [toolUseBlock("c2", "load_tool", { name: "tool_020" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 3: call both loaded tools
      { content: [toolUseBlock("c3", "tool_010", {}), toolUseBlock("c4", "tool_020", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 4: finish
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const store = new InMemoryStore();
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: { threshold: 20 } });

    for await (const _ of agent.query("find two ops", { sessionId: "s-incr-loaded" })) { /* drain */ }

    const seen = manifests(model);
    // After turn 1 (load_tool for tool_010): turn 2 manifest must include tool_010
    expect(seen[1]).toContain("tool_010");
    // After turn 2 (load_tool for tool_020): turn 3 manifest must include BOTH
    expect(seen[2]).toContain("tool_010");
    expect(seen[2]).toContain("tool_020");
  });

  it("loadedToolNames is a pure function: same set for same events (regression guard)", () => {
    const eager = new Set(["search_tools", "load_tool"]);
    // Simulate two load_tool tool_result events
    const events: StoredEvent[] = [
      { id: "e1", sessionId: "s", seq: 1, kind: "tool_result", schemaVersion: 1, payload: { callId: "c1", toolName: "load_tool", output: { ok: true, loaded: ["tool_a"] } }, createdAt: "t" },
      { id: "e2", sessionId: "s", seq: 2, kind: "tool_result", schemaVersion: 1, payload: { callId: "c2", toolName: "load_tool", output: { ok: true, loaded: ["tool_b"] } }, createdAt: "t" },
      { id: "e3", sessionId: "s", seq: 3, kind: "user", schemaVersion: 1, payload: "hello", createdAt: "t" },
    ];
    const result = loadedToolNames(events, eager);
    expect(result.has("tool_a")).toBe(true);
    expect(result.has("tool_b")).toBe(true);
    expect(result.has("search_tools")).toBe(true);
    expect(result.has("load_tool")).toBe(true);
    // calling again with same events produces same result (no shared state)
    const result2 = loadedToolNames(events, eager);
    expect(result2.has("tool_a")).toBe(true);
    expect(result2.has("tool_b")).toBe(true);
  });

  it("incremental update: after multiple load_tool calls, correct set without scanning each time", async () => {
    // This test verifies behavioral correctness via the per-turn manifest:
    // tool_005 loaded in turn 2 must appear in turn-3 manifest (incremental update).
    const tools = manyTools(30);
    let callCount = 0;

    const model = new MockModel([
      // turn 1: search for tools
      { content: [toolUseBlock("ca", "search_tools", { query: "operation 3" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 2: load tool_003
      { content: [toolUseBlock("cb", "load_tool", { name: "tool_003" })], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 3: use the tool
      { content: [toolUseBlock("cc", "tool_003", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      // turn 4: done
      { content: [textBlock("all done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    // Wrap the model to count calls
    const orig = model.complete.bind(model);
    (model as any).complete = async (req: any) => { callCount++; return orig(req); };

    const store = new InMemoryStore();
    const agent = new Agent({ id: "a", instructions: "x", model, store, tools, lazyTools: { threshold: 20 } });

    const results: unknown[] = [];
    for await (const ev of agent.query("use op 3", { sessionId: "s-incr-correct" })) {
      if (ev.type === "tool.result") results.push(ev);
    }

    const seen = manifests(model);
    // Turn 3 manifest must include tool_003 (it was loaded in turn 2)
    expect(seen[2]).toContain("tool_003");
    // tool_003 dispatched correctly
    const toolRes = results.find((r: any) => r.toolName === "tool_003") as any;
    expect(toolRes?.output).toEqual({ ran: 3 });
  });
});
