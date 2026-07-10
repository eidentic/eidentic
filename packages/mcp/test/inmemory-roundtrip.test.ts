/**
 * Real SDK in-memory transport round-trip tests (§5.5 D4).
 *
 * Uses `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/sdk/inMemory.js`
 * to wire a real SDK `Client` ↔ Eidentic `createMcpServer` round-trip entirely in-process.
 * This tests the full stack: JSON-RPC negotiation, tool listing, and tool invocation —
 * not just handler dispatch via the FakeMcpServer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { createTool } from "@eidentic/core";
import { createMcpServer, mcpServer, type AgentLike } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test tools
// ---------------------------------------------------------------------------
const addTool = createTool({
  id: "add",
  description: "Add two numbers.",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ input }) => input.a + input.b,
});

const greetTool = createTool({
  id: "greet",
  description: "Greet someone.",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ input }) => `Hello, ${input.name}!`,
});

const boomTool = createTool({
  id: "boom",
  description: "Always throws.",
  inputSchema: z.object({}),
  execute: async () => { throw new Error("kaboom from boom tool"); },
});

// ---------------------------------------------------------------------------
// Helper: build a connected Client+Server pair using SDK InMemoryTransport
// ---------------------------------------------------------------------------
async function buildPair(tools: Parameters<typeof createMcpServer>[0], opts?: Parameters<typeof createMcpServer>[1]) {
  // Dynamic imports — SDK is a dev dep; keep the module SDK-free at import time.
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const handle = await createMcpServer(tools, opts);
  // Connect the Eidentic MCP server to the server-side transport.
  await handle.server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return { client, handle };
}

// ---------------------------------------------------------------------------
// createMcpServer — in-memory round-trip
// ---------------------------------------------------------------------------
describe("createMcpServer — in-memory SDK round-trip", () => {
  let handle: Awaited<ReturnType<typeof createMcpServer>> | undefined;

  afterEach(async () => {
    await handle?.server.close();
    handle = undefined;
  });

  it("lists registered tools via a real SDK Client", async () => {
    const pair = await buildPair([addTool, greetTool]);
    handle = pair.handle;

    const { tools } = await pair.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "greet"]);

    const add = tools.find((t) => t.name === "add")!;
    expect(add.description).toBe("Add two numbers.");
    // inputSchema should be a JSON Schema object with properties
    expect((add.inputSchema as any).properties).toMatchObject({
      a: expect.objectContaining({ type: "number" }),
      b: expect.objectContaining({ type: "number" }),
    });
  });

  it("calls a tool and returns the result as text content", async () => {
    const pair = await buildPair([addTool]);
    handle = pair.handle;

    const result = await pair.client.callTool({ name: "add", arguments: { a: 10, b: 32 } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect((result.content[0] as any).text).toBe("42");
  });

  it("returns a string tool result as JSON-stringified text", async () => {
    const pair = await buildPair([greetTool]);
    handle = pair.handle;

    const result = await pair.client.callTool({ name: "greet", arguments: { name: "Eidentic" } });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toBe(JSON.stringify("Hello, Eidentic!"));
  });

  it("surfaces a throwing tool as isError:true (no unhandled rejection)", async () => {
    const pair = await buildPair([boomTool]);
    handle = pair.handle;

    const result = await pair.client.callTool({ name: "boom", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("kaboom");
  });

  it("returns isError:true for an unknown tool name", async () => {
    const pair = await buildPair([addTool]);
    handle = pair.handle;

    const result = await pair.client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("unknown tool");
  });

  it("handles multiple tools in a single server (list + call)", async () => {
    const pair = await buildPair([addTool, greetTool, boomTool]);
    handle = pair.handle;

    const { tools } = await pair.client.listTools();
    expect(tools).toHaveLength(3);

    // Call one that works, one that fails
    const ok = await pair.client.callTool({ name: "greet", arguments: { name: "world" } });
    expect(ok.isError).toBeFalsy();

    const err = await pair.client.callTool({ name: "boom", arguments: {} });
    expect(err.isError).toBe(true);
  });

  it("receives real SDK RequestHandlerExtra transport context in auth and authorization hooks", async () => {
    const authContexts: unknown[] = [];
    const authorizePrincipals: unknown[] = [];
    const principal = { subject: "sdk-client" };
    const pair = await buildPair([addTool], {
      authenticateConnection: (context) => {
        authContexts.push(context);
        return { principal };
      },
      authorize: (_name, _input, context) => {
        authorizePrincipals.push(context.principal);
        return true;
      },
    });
    handle = pair.handle;

    const result = await pair.client.callTool({ name: "add", arguments: { a: 1, b: 2 } });
    expect(result.isError).toBeFalsy();
    expect(authContexts.at(-1)).toEqual(expect.objectContaining({
      request: expect.objectContaining({ params: expect.objectContaining({ name: "add" }) }),
      transport: expect.any(Object),
    }));
    expect(authorizePrincipals).toContain(principal);
  });

  it("refuses unauthenticated Streamable HTTP unless explicitly opted in", async () => {
    handle = await createMcpServer([addTool]);
    expect(() => handle!.serveHttp()).toThrow(/requires authenticateConnection/i);
    await handle.server.close();

    handle = await createMcpServer([addTool], { allowUnauthenticatedHttp: true });
    expect(() => handle!.serveHttp()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mcpServer (opts-style API) — in-memory round-trip
// ---------------------------------------------------------------------------
describe("mcpServer (opts API) — in-memory SDK round-trip", () => {
  let handle: Awaited<ReturnType<typeof mcpServer>> | undefined;

  afterEach(async () => {
    await handle?.server.close();
    handle = undefined;
  });

  it("lists tools provided via opts.tools", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    handle = await mcpServer({ tools: [addTool, greetTool], name: "opts-test", version: "0.0.0" });
    await handle.server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "greet"]);
  });

  it("calls a tool end-to-end via opts API", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    handle = await mcpServer({ tools: [addTool] });
    await handle.server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "add", arguments: { a: 7, b: 8 } });
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toBe("15");
  });

  it("exposes an agent as an extra MCP tool", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const fakeAgent: AgentLike = {
      async query(input: string) { return `agent says: ${input}`; },
    };

    handle = await mcpServer({
      tools: [addTool],
      agent: fakeAgent,
      agentId: "my_agent",
      agentDescription: "A test agent",
      allowDestructive: true, // agent tool is destructive — opt in explicitly
    });
    await handle.server.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add", "my_agent"]);

    const agentTool = tools.find((t) => t.name === "my_agent")!;
    expect(agentTool.description).toBe("A test agent");

    const result = await client.callTool({ name: "my_agent", arguments: { input: "hello" } });
    expect(result.isError).toBeFalsy();
    // Tool results are JSON.stringify'd by createMcpServer, so a string becomes a quoted string.
    expect((result.content[0] as any).text).toBe(JSON.stringify("agent says: hello"));
  });

  it("maps a verified principal for a real SDK agent tool and ignores spoofed identity args", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let captured: unknown;
    const fakeAgent: AgentLike = {
      async query(_input, options) {
        captured = options;
        return "ok";
      },
    };

    handle = await mcpServer({
      tools: [],
      agent: fakeAgent,
      agentId: "secure_agent",
      allowDestructive: true,
      authenticateConnection: () => ({ principal: { subject: "verified" } }),
      agentIdentity: (principal) => ({ userId: (principal as { subject: string }).subject }),
    });
    await handle.server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const schema = listed.tools[0]?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("userId");
    await client.callTool({
      name: "secure_agent",
      arguments: { input: "hello", userId: "spoofed", apiKey: "raw-secret" },
    });
    expect(captured).toEqual(expect.objectContaining({ userId: "verified" }));
    expect(JSON.stringify(captured)).not.toContain("spoofed");
    expect(JSON.stringify(captured)).not.toContain("raw-secret");
  });

  it("throws if agentId is missing when agent is provided", async () => {
    const fakeAgent: AgentLike = { async query() { return ""; } };
    await expect(
      mcpServer({ tools: [], agent: fakeAgent }), // agentId missing
    ).rejects.toThrow(/agentId/);
  });
});
