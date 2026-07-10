import { describe, it, expect } from "vitest";
import { Agent, createTool, replayHash } from "../src/index.js";
import { loadedToolNames } from "../src/discovery-tools.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ToolSchema } from "@eidentic/types";
import { z } from "zod";

function manyTools(n: number) {
  return Array.from({ length: n }, (_, i) =>
    createTool({
      id: `tool_${String(i).padStart(3, "0")}`,
      description: `Tool ${i} op ${i}`,
      inputSchema: z.object({}),
      execute: async () => ({ ran: i }),
    }),
  );
}

function manifests(model: MockModel): string[][] {
  return model.calls.map((c) => c.tools.map((t: ToolSchema) => t.name));
}

describe("lazy resume determinism (§5.4, invariant b)", () => {
  it("resume reconstructs the loaded-set from the event log; manifest + replay hash stable", async () => {
    const tools = manyTools(30);
    const store = new InMemoryStore();
    const sessionId = "resume-1";

    // A tool that suspends for human approval.
    const approval = createTool({
      id: "needs_approval",
      description: "A gated action requiring human approval before it proceeds",
      inputSchema: z.object({}),
      sideEffect: "destructive",
      idempotencyKey: () => "appr-1",
      execute: async ({ ctx }) => {
        const d = await ctx!.suspend!({ reason: "approve?" });
        return { approved: (d as { approved: boolean }).approved };
      },
    });

    // Phase 1: model load_tool("tool_012"), then calls needs_approval → SUSPENDED.
    const model1 = new MockModel([
      { content: [toolUseBlock("c1", "load_tool", { name: "tool_012" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c2", "needs_approval", {})], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent1 = new Agent({
      permissions: { mode: "bypass" },
      id: "a", instructions: "x", model: model1, store,
      tools: [...tools, approval], durable: true, lazyTools: { threshold: 20 },
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    let suspended = false;
    for await (const ev of agent1.query("go", { sessionId })) {
      if (ev.type === "result" && ev.subtype === "suspended") suspended = true;
    }
    expect(suspended).toBe(true);

    // Read the event log directly from the store (InMemoryStore exposes readEvents).
    const session1Events = await store.readEvents(sessionId);

    // The load_tool tool_result is in the log → loaded-set already includes tool_012.
    // The eager set mirrors what resolveLazyTools produces for the two meta-tools.
    const eagerMeta = new Set(["search_tools", "load_tool"]);
    const loadedAfterPhase1 = loadedToolNames(session1Events, eagerMeta);
    expect([...loadedAfterPhase1]).toContain("tool_012");

    // Capture the replay hash of the log before resume.
    const hashBeforeResume = await replayHash([...session1Events]);

    // Phase 2: resume with approval. The model now calls tool_012 (which was loaded in phase 1).
    const model2 = new MockModel([
      { content: [toolUseBlock("c3", "tool_012", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("finished")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent2 = new Agent({
      permissions: { mode: "bypass" },
      id: "a", instructions: "x", model: model2, store,
      tools: [...tools, approval], durable: true, lazyTools: { threshold: 20 },
      now: () => "t", newId: ((n) => () => `r${n++}`)(0),
    });
    for await (const _ of agent2.resume(sessionId, { decision: { approved: true } })) { /* drain */ }

    // On resume, the FIRST model call's manifest already contains tool_012 — reconstructed from the
    // event log, not re-discovered. This is the determinism guarantee (invariant b):
    // loadedToolNames(events, eager) is a pure function of (events + config).
    expect(manifests(model2)[0]).toContain("tool_012");
    expect(manifests(model2)[0]).toContain("search_tools");

    // The replay hash of the log prefix that existed before resume is unchanged — the lazy layer
    // derives state from events, never writes a new event kind, so the hash is stable.
    const afterEvents = await store.readEvents(sessionId);
    expect(await replayHash(afterEvents.slice(0, session1Events.length))).toBe(hashBeforeResume);
  });
});
