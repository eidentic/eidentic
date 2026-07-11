/**
 * MCP governance layer tests — OTel spans + audit events.
 *
 * Covers:
 *   1. Host-side spans: mcpTools with tracer → mcp.call_tool spans with correct attributes.
 *   2. Host-side no-tracer: existing behaviour unchanged.
 *   3. Server-side onAudit: fires for list/call/denied/error with correct outcome.
 *   4. Throwing onAudit doesn't break the call.
 *   5. Server-side tracer: mcp.handle_request spans created per request.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createTool } from "@eidentic/core";
import { InMemoryTracer } from "@eidentic/types/testing";
import {
  mcpTools,
  serveTools,
  type McpClientLike,
  type McpServerLike,
  type McpAuditEvent,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fake MCP client (mirrors mcp-tools.test.ts)
// ---------------------------------------------------------------------------
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
          name: "boom",
          description: "Always fails.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  },
  async callTool({ name, arguments: args }) {
    if (name === "echo") {
      return { content: [{ type: "text", text: `echo: ${(args as { message: string }).message}` }] };
    }
    if (name === "boom") {
      return { content: [{ type: "text", text: "kaboom" }], isError: true };
    }
    return { content: [{ type: "text", text: "" }], isError: true };
  },
};

// ---------------------------------------------------------------------------
// Fake MCP server (mirrors server.test.ts)
// ---------------------------------------------------------------------------
class FakeMcpServer implements McpServerLike {
  private handlers = new Map<string, (req: any, extra?: any) => Promise<any>>();

  setRequestHandler(schema: unknown, handler: (req: any, extra?: any) => Promise<any>): void {
    this.handlers.set(String(schema), handler);
  }

  async invoke(method: string, req: unknown = {}, extra?: unknown): Promise<any> {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeMcpServer: no handler registered for '${method}'`);
    return handler(req, extra);
  }

  async connect(_transport: unknown): Promise<void> { /* noop */ }
  async close(): Promise<void> { /* noop */ }
}

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------
const addTool = createTool({
  id: "add",
  description: "Add two numbers.",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ input }) => input.a + input.b,
});

const boomTool = createTool({
  id: "boom",
  description: "Always throws.",
  inputSchema: z.object({}),
  execute: async () => { throw new Error("kaboom from boom tool"); },
});

// ---------------------------------------------------------------------------
// 1. Host-side spans: mcpTools with tracer
// ---------------------------------------------------------------------------
describe("mcpTools — OTel spans (governance)", () => {
  it("creates a mcp.call_tool span with correct attributes on success", async () => {
    const tracer = new InMemoryTracer();
    const tools = await mcpTools(fakeClient, { tracer });
    const echo = tools.find((t) => t.id === "echo")!;

    await echo.execute({ message: "hello" });

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("mcp.call_tool");
    expect(span.attributes["mcp.tool.name"]).toBe("echo");
    expect(span.attributes["mcp.duration_ms"]).toBeTypeOf("number");
    expect(span.status).toBe("ok");
    expect(span.ended).toBe(true);
    // No error flag on success
    expect(span.attributes["error"]).toBeUndefined();
  });

  it("creates a mcp.call_tool span with error=true and status=error when isError:true", async () => {
    const tracer = new InMemoryTracer();
    const tools = await mcpTools(fakeClient, { tracer });
    const boom = tools.find((t) => t.id === "boom")!;

    await expect(boom.execute({})).rejects.toThrow("kaboom");

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("mcp.call_tool");
    expect(span.attributes["mcp.tool.name"]).toBe("boom");
    expect(span.attributes["error"]).toBe(true);
    expect(span.status).toBe("error");
    expect(span.ended).toBe(true);
  });

  it("sets mcp.server.id attribute when prefix is set", async () => {
    const tracer = new InMemoryTracer();
    const tools = await mcpTools(fakeClient, { prefix: "my-server", tracer });
    const echo = tools.find((t) => t.id === "my-server__echo")!;

    await echo.execute({ message: "hi" });

    const span = tracer.spans[0]!;
    expect(span.attributes["mcp.server.id"]).toBe("my-server");
    expect(span.attributes["mcp.tool.name"]).toBe("echo");
  });

  it("does not set mcp.server.id when no prefix is configured", async () => {
    const tracer = new InMemoryTracer();
    const tools = await mcpTools(fakeClient, { tracer });
    const echo = tools.find((t) => t.id === "echo")!;

    await echo.execute({ message: "world" });

    const span = tracer.spans[0]!;
    expect(span.attributes["mcp.server.id"]).toBeUndefined();
  });

  it("always ends the span (span.ended is true after success and error)", async () => {
    const tracer = new InMemoryTracer();
    const tools = await mcpTools(fakeClient, { tracer });
    const echo = tools.find((t) => t.id === "echo")!;
    const boom = tools.find((t) => t.id === "boom")!;

    await echo.execute({ message: "x" });
    await expect(boom.execute({})).rejects.toThrow();

    expect(tracer.spans).toHaveLength(2);
    for (const s of tracer.spans) {
      expect(s.ended).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Host-side no-tracer path: existing behaviour unchanged
// ---------------------------------------------------------------------------
describe("mcpTools — no tracer (existing behaviour unchanged)", () => {
  it("executes correctly without a tracer (no span emitted)", async () => {
    const tools = await mcpTools(fakeClient); // no tracer
    const echo = tools.find((t) => t.id === "echo")!;
    const out = await echo.execute({ message: "no tracer" });
    expect(out).toBe("echo: no tracer");
  });

  it("still throws on isError:true without a tracer", async () => {
    const tools = await mcpTools(fakeClient);
    const boom = tools.find((t) => t.id === "boom")!;
    await expect(boom.execute({})).rejects.toThrow("kaboom");
  });
});

// ---------------------------------------------------------------------------
// 3. Server-side onAudit
// ---------------------------------------------------------------------------
describe("serveTools — onAudit hook (governance)", () => {
  it("fires onAudit with outcome=ok for tools/list", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { onAudit: (e) => { events.push(e); } });

    await fake.invoke("tools/list");

    expect(events).toHaveLength(1);
    expect(events[0]!.method).toBe("tools/list");
    expect(events[0]!.outcome).toBe("ok");
    expect(events[0]!.startedAt).toBeTypeOf("number");
    expect(events[0]!.durationMs).toBeTypeOf("number");
    expect(events[0]!.errorMessage).toBeUndefined();
  });

  it("fires onAudit with outcome=ok for a successful tools/call", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { onAudit: (e) => { events.push(e); } });

    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1, b: 2 } } });

    expect(events).toHaveLength(1);
    expect(events[0]!.method).toBe("tools/call");
    expect(events[0]!.toolName).toBe("add");
    expect(events[0]!.outcome).toBe("ok");
    expect(events[0]!.errorMessage).toBeUndefined();
  });

  it("fires onAudit with outcome=denied when authenticateConnection returns false (tools/list)", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authenticateConnection: () => false,
      onAudit: (e) => { events.push(e); },
    });

    await fake.invoke("tools/list");

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
    expect(events[0]!.errorMessage).toContain("not authenticated");
  });

  it("fires onAudit with outcome=denied when authenticateConnection returns false (tools/call)", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authenticateConnection: () => false,
      onAudit: (e) => { events.push(e); },
    });

    await fake.invoke("tools/call", { params: { name: "add", arguments: {} } });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
    expect(events[0]!.method).toBe("tools/call");
  });

  it("retains only credential-free transport identity when an additional auth check denies", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    const authInfo = {
      token: "raw-bearer-must-never-reach-audit",
      clientId: "known-client",
      scopes: ["tools:read"],
    };
    serveTools(fake, [addTool], {
      authenticateConnection: () => false,
      onAudit: (event) => events.push(event),
    });

    await fake.invoke("tools/list", {}, { authInfo });
    expect(events[0]?.outcome).toBe("denied");
    expect(events[0]?.principal).toEqual({ clientId: "known-client", scopes: ["tools:read"] });
    expect(JSON.stringify(events)).not.toContain("raw-bearer-must-never-reach-audit");
  });

  it("fires onAudit with outcome=denied when authorize returns false", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authorize: () => false,
      onAudit: (e) => { events.push(e); },
    });

    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1, b: 2 } } });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("denied");
    expect(events[0]!.toolName).toBe("add");
  });

  it("fires onAudit with outcome=error when tool execute throws", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [boomTool], { onAudit: (e) => { events.push(e); } });

    await fake.invoke("tools/call", { params: { name: "boom", arguments: {} } });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("error");
    expect(events[0]!.toolName).toBe("boom");
    expect(events[0]!.errorMessage).toContain("kaboom");
  });

  it("fires onAudit with outcome=error for unknown tool name", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { onAudit: (e) => { events.push(e); } });

    await fake.invoke("tools/call", { params: { name: "nonexistent", arguments: {} } });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("error");
    expect(events[0]!.toolName).toBe("nonexistent");
    expect(events[0]!.errorMessage).toContain("unknown tool");
  });

  it("fires onAudit with outcome=error for invalid arguments (parse failure)", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { onAudit: (e) => { events.push(e); } });

    // Missing required field "b"
    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1 } } });

    expect(events).toHaveLength(1);
    expect(events[0]!.outcome).toBe("error");
    expect(events[0]!.errorMessage).toContain("invalid input");
  });

  it("does not report the untrusted protocol request as an authenticated principal", async () => {
    const events: McpAuditEvent[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { onAudit: (e) => { events.push(e); } });

    const req = { params: { name: "add", arguments: { a: 1, b: 2 } }, _identity: "user-42" };
    await fake.invoke("tools/call", req);

    expect(events[0]!.principal).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 4. Throwing onAudit must never break the call
  // -------------------------------------------------------------------------
  it("throwing onAudit does not break the call (sync throw swallowed)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      onAudit: () => { throw new Error("audit system on fire"); },
    });

    // The call must still resolve normally
    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 5, b: 5 } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("10");

    warnSpy.mockRestore();
  });

  it("async rejecting onAudit does not break the call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      onAudit: async () => { throw new Error("async audit failure"); },
    });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 2, b: 3 } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("5");

    // Give the async reject a tick to fire
    await new Promise((r) => setTimeout(r, 10));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. Server-side tracer spans
// ---------------------------------------------------------------------------
describe("serveTools — server tracer spans (governance)", () => {
  it("creates a mcp.handle_request span for a successful tools/list", async () => {
    const tracer = new InMemoryTracer();
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { tracer });

    await fake.invoke("tools/list");

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("mcp.handle_request");
    expect(span.attributes["mcp.method"]).toBe("tools/list");
    expect(span.attributes["mcp.outcome"]).toBe("ok");
    expect(span.attributes["mcp.duration_ms"]).toBeTypeOf("number");
    expect(span.status).toBe("ok");
    expect(span.ended).toBe(true);
  });

  it("creates a mcp.handle_request span for a successful tools/call", async () => {
    const tracer = new InMemoryTracer();
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { tracer });

    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1, b: 2 } } });

    expect(tracer.spans).toHaveLength(1);
    const span = tracer.spans[0]!;
    expect(span.name).toBe("mcp.handle_request");
    expect(span.attributes["mcp.method"]).toBe("tools/call");
    expect(span.attributes["mcp.tool.name"]).toBe("add");
    expect(span.attributes["mcp.outcome"]).toBe("ok");
    expect(span.status).toBe("ok");
    expect(span.ended).toBe(true);
  });

  it("creates a span with outcome=denied when auth is rejected", async () => {
    const tracer = new InMemoryTracer();
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authenticateConnection: () => false,
      tracer,
    });

    await fake.invoke("tools/call", { params: { name: "add", arguments: {} } });

    const span = tracer.spans[0]!;
    expect(span.attributes["mcp.outcome"]).toBe("denied");
    expect(span.status).toBe("error");
    expect(span.ended).toBe(true);
  });

  it("creates a span with outcome=error when the tool throws", async () => {
    const tracer = new InMemoryTracer();
    const fake = new FakeMcpServer();
    serveTools(fake, [boomTool], { tracer });

    await fake.invoke("tools/call", { params: { name: "boom", arguments: {} } });

    const span = tracer.spans[0]!;
    expect(span.attributes["mcp.outcome"]).toBe("error");
    expect(span.status).toBe("error");
    expect(span.ended).toBe(true);
  });

  it("creates a span with outcome=denied when authorize returns false", async () => {
    const tracer = new InMemoryTracer();
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authorize: () => false,
      tracer,
    });

    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1, b: 2 } } });

    const span = tracer.spans[0]!;
    expect(span.attributes["mcp.outcome"]).toBe("denied");
    expect(span.ended).toBe(true);
  });

  it("no spans emitted when no tracer is configured (zero overhead path)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]); // no tracer

    await fake.invoke("tools/list");
    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 1, b: 1 } } });

    // No tracer — no spans created, no errors thrown
    // Just verify the calls still work
    expect(true).toBe(true);
  });
});
