import { describe, it, expect } from "vitest";
import { ToolRegistry } from "@eidentic/core";
import { mcpTools, type McpClientLike } from "../src/index.js";

/**
 * Faithful in-memory MCP client. Mirrors the REAL `@modelcontextprotocol/sdk` `Client`
 * subset that `mcpTools` relies on (confirmed in the Spike against sdk@1.29.0):
 *   - `listTools()` → `{ tools: Array<{ name, description?, inputSchema, annotations? }> }`
 *   - `callTool({ name, arguments })` → `{ content: Array<{ type, text?, ... }>, isError? }`
 * Tool surface:
 *   - `echo`        readOnlyHint:true  → MUST wrap as sideEffect "read-only"
 *   - `write_note`  (unannotated)      → MUST wrap as sideEffect "destructive" (§5.5 safe default)
 *   - `boom`        (unannotated)      → callTool returns isError:true (maps to a Eidentic tool error)
 */
const fakeClient: McpClientLike = {
  async listTools() {
    return {
      tools: [
        {
          name: "echo",
          description: "Echo the message back.",
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          annotations: { readOnlyHint: true },
        },
        {
          name: "write_note",
          description: "Persist a note (side-effecting).",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          // no annotations → defaults to destructive
        },
        {
          name: "boom",
          description: "Always fails.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool({ name, arguments: args }) {
    if (name === "echo") return { content: [{ type: "text", text: `echo: ${(args as { message: string }).message}` }] };
    if (name === "write_note") return { content: [{ type: "text", text: `saved: ${(args as { text: string }).text}` }] };
    if (name === "boom") return { content: [{ type: "text", text: "kaboom" }], isError: true };
    return { content: [{ type: "text", text: "" }], isError: true };
  },
};

describe("mcpTools wrapping (faithful in-memory fake)", () => {
  it("wraps every MCP tool with id/description/jsonSchema passed through", async () => {
    const tools = await mcpTools(fakeClient);
    const byId = new Map(tools.map((t) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual(["boom", "echo", "write_note"]);
    expect(byId.get("echo")!.description).toBe("Echo the message back.");
    // jsonSchema is the MCP inputSchema passed through verbatim.
    expect(byId.get("echo")!.jsonSchema).toEqual({
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    });
  });

  it("maps annotations per §5.5: readOnlyHint→read-only, unannotated→destructive", async () => {
    const tools = await mcpTools(fakeClient);
    const byId = new Map(tools.map((t) => [t.id, t]));
    expect(byId.get("echo")!.sideEffect).toBe("read-only");        // readOnlyHint:true
    expect(byId.get("write_note")!.sideEffect).toBe("destructive"); // unannotated → safe default
    expect(byId.get("boom")!.sideEffect).toBe("destructive");
  });

  it("honors opts.defaultSideEffect for unannotated tools but never overrides readOnlyHint", async () => {
    const tools = await mcpTools(fakeClient, { defaultSideEffect: "idempotent" });
    const byId = new Map(tools.map((t) => [t.id, t]));
    expect(byId.get("write_note")!.sideEffect).toBe("idempotent"); // override applies to unannotated
    expect(byId.get("echo")!.sideEffect).toBe("read-only");        // readOnlyHint still wins
  });

  it("prefixes ids with `${prefix}__${name}` when opts.prefix is set; no prefix by default", async () => {
    const noPrefix = await mcpTools(fakeClient);
    expect(noPrefix.map((t) => t.id)).toContain("echo");
    const prefixed = await mcpTools(fakeClient, { prefix: "gh" });
    expect(prefixed.map((t) => t.id).sort()).toEqual(["gh__boom", "gh__echo", "gh__write_note"]);
  });

  it("parse is a pass-through (server validates args server-side)", async () => {
    const [echo] = await mcpTools(fakeClient);
    const r = echo!.parse({ message: "hi" });
    expect(r).toEqual({ ok: true, value: { message: "hi" } });
  });

  it("execute calls callTool and returns the joined text content", async () => {
    const tools = await mcpTools(fakeClient);
    const echo = tools.find((t) => t.id === "echo")!;
    const out = await echo.execute({ message: "hi" });
    expect(out).toBe("echo: hi");
  });

  it("surfaces an MCP isError:true as a thrown error carrying the text", async () => {
    const tools = await mcpTools(fakeClient);
    const boom = tools.find((t) => t.id === "boom")!;
    await expect(boom.execute({})).rejects.toThrow("kaboom");
  });
});

describe("mcpTools end-to-end through a real ToolRegistry", () => {
  it("dispatches a read-only MCP tool and returns mapped output", async () => {
    const registry = new ToolRegistry(await mcpTools(fakeClient));
    const [res] = await registry.dispatch([{ callId: "c1", name: "echo", input: { message: "world" } }]);
    expect(res!.isError).toBe(false);
    expect(res!.output).toBe("echo: world");
  });

  it("dispatches a destructive MCP tool serially and maps isError to a Eidentic tool error", async () => {
    const registry = new ToolRegistry(await mcpTools(fakeClient));
    const results = await registry.dispatch([
      { callId: "c1", name: "write_note", input: { text: "buy milk" } },
      { callId: "c2", name: "boom", input: {} },
    ]);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.output).toBe("saved: buy milk");
    expect(results[1]!.isError).toBe(true);
    expect((results[1]!.output as { error: string }).error).toContain("kaboom");
  });
});

describe("mcpTools structuredContent (Fix 2)", () => {
  it("surfaces structuredContent as JSON when text content is empty", async () => {
    const structuredClient: McpClientLike = {
      async listTools() {
        return {
          tools: [
            {
              name: "structured_tool",
              description: "Returns only structured data.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      },
      async callTool() {
        // Empty text content — only structuredContent present (real pattern for data-returning tools)
        return {
          content: [],
          structuredContent: { count: 42, items: ["a", "b"] },
        };
      },
    };
    const [tool] = await mcpTools(structuredClient);
    const out = await tool!.execute({});
    expect(out).toBe(JSON.stringify({ count: 42, items: ["a", "b"] }));
  });

  it("returns text content when both text and structuredContent are present", async () => {
    const bothClient: McpClientLike = {
      async listTools() {
        return {
          tools: [{ name: "both", description: "Both.", inputSchema: { type: "object", properties: {} } }],
        };
      },
      async callTool() {
        return {
          content: [{ type: "text", text: "text result" }],
          structuredContent: { key: "value" },
        };
      },
    };
    const [tool] = await mcpTools(bothClient);
    const out = await tool!.execute({});
    expect(out).toBe("text result");
  });
});

describe("mcpTools id-collision guard (Fix 3)", () => {
  it("throws a clear error when two tools resolve to the same id after prefixing", async () => {
    // Simulate a pathological server that returns two tools with the same name (or names
    // that collide after prefix normalization — here we test the direct duplicate case).
    const dupClient: McpClientLike = {
      async listTools() {
        return {
          tools: [
            { name: "tool", description: "first", inputSchema: { type: "object", properties: {} } },
            { name: "tool", description: "second", inputSchema: { type: "object", properties: {} } },
          ],
        };
      },
      async callTool() { return { content: [] }; },
    };
    await expect(mcpTools(dupClient)).rejects.toThrow(/duplicate tool id/i);
  });

  it("does not throw when all tool ids are distinct", async () => {
    await expect(mcpTools(fakeClient)).resolves.toHaveLength(3);
  });
});

describe("mcpTools forceSideEffect (Fix 3)", () => {
  it("forceSideEffect:destructive overrides readOnlyHint:true on all tools", async () => {
    const tools = await mcpTools(fakeClient, { forceSideEffect: "destructive" });
    const byId = new Map(tools.map((t) => [t.id, t]));
    // echo has readOnlyHint:true but forceSideEffect must win
    expect(byId.get("echo")!.sideEffect).toBe("destructive");
    // write_note is already destructive by default — unchanged
    expect(byId.get("write_note")!.sideEffect).toBe("destructive");
  });

  it("forceSideEffect:idempotent applies to all tools regardless of annotation", async () => {
    const tools = await mcpTools(fakeClient, { forceSideEffect: "idempotent" });
    for (const t of tools) {
      expect(t.sideEffect).toBe("idempotent");
    }
  });
});
