import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type Scope } from "@eidentic/types";
import { Agent, createTool } from "../src/index.js";

const usage = { inputTokens: 1, outputTokens: 1 };

describe("Agent query options", () => {
  it("separates trusted principal ownership from explicit memory/tool scope", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const contactScope: Scope = {
      kind: "user",
      agentId: "heynorah",
      userId: "workspace:ws1:contact:c1",
    };
    let capturedScope: Scope | undefined;
    const inspectScope = createTool({
      id: "inspect_scope",
      description: "captures the current scope",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => {
        capturedScope = ctx?.scope;
        return { ok: true };
      },
    });
    const model = new MockModel([
      { content: [toolUseBlock("c1", "inspect_scope", {})], usage },
      { content: [textBlock("done")], usage },
    ]);
    const agent = new Agent({
      id: "heynorah",
      instructions: "test",
      model,
      store,
      tools: [inspectScope],
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    for await (const _ of agent.query("hello", {
      sessionId: "scope-separation",
      principal: { userId: "viewer_u1", orgId: "ws1" },
      memoryScope: contactScope,
    })) { /* drain */ }

    expect(capturedScope).toEqual(contactScope);
    const session = await store.getSession("scope-separation");
    expect(session?.userId).toBe("viewer_u1");
    expect(session?.orgId).toBe("ws1");
  });
});
