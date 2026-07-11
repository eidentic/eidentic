import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool } from "@eidentic/core";
import {
  serveTools,
  serveAgent,
  type McpServerLike,
  type AgentLike,
  type McpTransportContext,
  type McpAgentIdentity,
} from "../src/index.js";

// Public-type surface compile check for security integration hooks.
const _publicTypeCheck: [McpTransportContext?, McpAgentIdentity?] = [];
void _publicTypeCheck;

// ---------------------------------------------------------------------------
// Faithful in-memory McpServerLike fake
//
// Mirrors how the real SDK Server.setRequestHandler works:
//   - Stores one handler per method string (or schema identity).
//   - Exposes `invoke(method, req)` so tests can call handlers directly,
//     simulating what the SDK does when a client sends a request.
// The fake accepts a schema of type `unknown` — for the structural serveTools
// interface the schema sentinel is the method string ("tools/list" / "tools/call").
// ---------------------------------------------------------------------------
class FakeMcpServer implements McpServerLike {
  private handlers = new Map<string, (req: any, extra?: any) => Promise<any>>();

  setRequestHandler(schema: unknown, handler: (req: any, extra?: any) => Promise<any>): void {
    // Schema is the string sentinel passed by serveTools ("tools/list" / "tools/call").
    const key = String(schema);
    this.handlers.set(key, handler);
  }

  /** Invoke a registered handler directly (simulates the SDK's request dispatch). */
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

const secretTool = createTool({
  id: "secret",
  description: "Returns and throws credential-shaped test data.",
  inputSchema: z.object({ fail: z.boolean().default(false) }),
  execute: async ({ input }) => {
    if (input.fail) throw new Error("Bearer transport-secret-value");
    return { apiKey: "transport-secret-value", nested: { ok: true } };
  },
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------
describe("serveTools — tools/list", () => {
  it("returns all registered tools with name, description, and inputSchema", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, greetTool]);

    const result = await fake.invoke("tools/list");
    expect(result.tools).toHaveLength(2);

    const byName = new Map(result.tools.map((t: any) => [t.name, t]));
    expect(byName.has("add")).toBe(true);
    expect(byName.has("greet")).toBe(true);

    const add = byName.get("add");
    expect(add.name).toBe("add");
    expect(add.description).toBe("Add two numbers.");
    // inputSchema is the JSON Schema object derived from the Zod schema.
    expect(add.inputSchema).toBeDefined();
    expect(typeof add.inputSchema).toBe("object");
    // Spot-check: should have properties for a and b.
    expect((add.inputSchema as any).properties).toMatchObject({
      a: expect.objectContaining({ type: "number" }),
      b: expect.objectContaining({ type: "number" }),
    });
  });

  it("tool ids become MCP tool names", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, greetTool, boomTool]);
    const { tools } = await fake.invoke("tools/list");
    expect(tools.map((t: any) => t.name).sort()).toEqual(["add", "boom", "greet"]);
  });
});

// ---------------------------------------------------------------------------
// tools/call — happy path
// ---------------------------------------------------------------------------
describe("serveTools — tools/call (happy path)", () => {
  it("executes the tool and returns JSON-stringified result as text content", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 3, b: 4 } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // The number 7 is JSON.stringified as "7"
    expect(result.content[0].text).toBe("7");
  });

  it("passes arguments as input to the tool", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [greetTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "greet", arguments: { name: "World" } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe(JSON.stringify("Hello, World!"));
  });

  it("redacts credential fields from successful tool output", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [secretTool]);
    const result = await fake.invoke("tools/call", {
      params: { name: "secret", arguments: { fail: false } },
    });
    expect(result.content[0].text).not.toContain("transport-secret-value");
    expect(JSON.parse(result.content[0].text)).toMatchObject({ apiKey: "***", nested: { ok: true } });
  });
});

// ---------------------------------------------------------------------------
// tools/call — error cases (must NEVER throw out of the handler)
// ---------------------------------------------------------------------------
describe("serveTools — tools/call (error cases)", () => {
  it("returns isError:true for an unknown tool name (no throw)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "nonexistent", arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown tool");
    expect(result.content[0].text).toContain("nonexistent");
  });

  it("returns isError:true when the tool execute throws (no throw escapes)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [boomTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "boom", arguments: {} },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });

  it("redacts bearer credentials from tool errors", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [secretTool]);
    const result = await fake.invoke("tools/call", {
      params: { name: "secret", arguments: { fail: true } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Bearer [REDACTED]");
    expect(result.content[0].text).not.toContain("transport-secret-value");
  });

  it("returns isError:true for invalid arguments (parse failure)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]);

    const result = await fake.invoke("tools/call", {
      // Missing required field "b"
      params: { name: "add", arguments: { a: 1 } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid input");
  });

  it("handler never throws — error is always encoded in the result", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [boomTool]);

    // If the handler threw, the await would reject. It must resolve.
    await expect(
      fake.invoke("tools/call", { params: { name: "boom", arguments: {} } }),
    ).resolves.toMatchObject({ isError: true });
  });
});

// ---------------------------------------------------------------------------
// Empty tools list
// ---------------------------------------------------------------------------
describe("serveTools — edge cases", () => {
  it("tools/list returns empty array when no tools registered", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, []);
    const { tools } = await fake.invoke("tools/list");
    expect(tools).toEqual([]);
  });

  it("tools/call on empty server returns isError:true for unknown tool", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, []);
    const result = await fake.invoke("tools/call", { params: { name: "any", arguments: {} } });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// serveAgent
// ---------------------------------------------------------------------------
describe("serveAgent — tools/list + tools/call", () => {
  const fakeAgent: AgentLike = {
    async query(input: string): Promise<unknown> {
      return `agent echoes: ${input}`;
    },
  };

  it("tools/list returns a single tool with {input:string} schema", async () => {
    const fake = new FakeMcpServer();
    serveAgent(fake, "my_agent", fakeAgent, "My test agent");

    const { tools } = await fake.invoke("tools/list");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("my_agent");
    expect(tools[0].description).toBe("My test agent");
    expect(tools[0].inputSchema.properties.input.type).toBe("string");
  });

  it("tools/call runs agent.query and returns result as text", async () => {
    const fake = new FakeMcpServer();
    serveAgent(fake, "my_agent", fakeAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "my_agent", arguments: { input: "hello" } },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("agent echoes: hello");
  });

  it("tools/call returns isError:true for wrong tool name", async () => {
    const fake = new FakeMcpServer();
    serveAgent(fake, "my_agent", fakeAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "other_agent", arguments: { input: "hello" } },
    });
    expect(result.isError).toBe(true);
  });

  it("tools/call returns isError:true when agent.query throws (no throw escapes)", async () => {
    const throwingAgent: AgentLike = {
      async query() { throw new Error("agent internal error"); },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "throw_agent", throwingAgent);

    await expect(
      fake.invoke("tools/call", { params: { name: "throw_agent", arguments: { input: "" } } }),
    ).resolves.toMatchObject({ isError: true });
  });
});

// ---------------------------------------------------------------------------
// Destructive tool opt-in (Finding #5 High — destructive-tool guard)
// ---------------------------------------------------------------------------

const bashLikeTool = createTool({
  id: "bash",
  description: "Run a shell command (destructive).",
  sideEffect: "destructive",
  inputSchema: z.object({ cmd: z.string() }),
  execute: async ({ input }) => `ran: ${input.cmd}`,
});

describe("serveTools — destructive tool opt-in", () => {
  it("skips destructive tools by default (not in tools/list)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, bashLikeTool]);

    const { tools } = await fake.invoke("tools/list");
    expect(tools.map((t: any) => t.name)).not.toContain("bash");
    expect(tools.map((t: any) => t.name)).toContain("add");
  });

  it("destructive tool returns isError when called without opt-in (not in byId)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [bashLikeTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "bash", arguments: { cmd: "rm -rf /" } },
    });
    expect(result.isError).toBe(true);
  });

  it("allows destructive tool when allowDestructive: true", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [bashLikeTool], { allowDestructive: true });

    const { tools } = await fake.invoke("tools/list");
    expect(tools.map((t: any) => t.name)).toContain("bash");

    const result = await fake.invoke("tools/call", {
      params: { name: "bash", arguments: { cmd: "echo hi" } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe(JSON.stringify("ran: echo hi"));
  });

  it("allows destructive tool when authorize hook is provided (even without allowDestructive)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [bashLikeTool], { authorize: () => true });

    const { tools } = await fake.invoke("tools/list");
    expect(tools.map((t: any) => t.name)).toContain("bash");

    const result = await fake.invoke("tools/call", {
      params: { name: "bash", arguments: { cmd: "echo hello" } },
    });
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// authorize hook (Finding #5 High — per-call authorization)
// ---------------------------------------------------------------------------

describe("serveTools — authorize hook", () => {
  it("authorize returning false blocks the tool call (isError:true)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authorize: () => false });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authorized");
  });

  it("authorize returning true allows the call", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authorize: () => true });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 2, b: 3 } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("5");
  });

  it("authorize receives the tool name and raw args", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authorize: (name, input) => {
        calls.push({ name, input });
        return true;
      },
    });

    await fake.invoke("tools/call", { params: { name: "add", arguments: { a: 9, b: 1 } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("add");
    expect(calls[0]!.input).toMatchObject({ a: 9, b: 1 });
  });

  it("async authorize returning false blocks the call", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authorize: async () => false });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(result.isError).toBe(true);
  });

  it("authorize that throws is treated as denial (isError:true)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authorize: () => { throw new Error("auth system unavailable"); },
    });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(result.isError).toBe(true);
  });

  it("authorize can allow some tools and deny others", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, greetTool], {
      authorize: (name) => name === "add",
    });

    const addResult = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 4, b: 4 } },
    });
    expect(addResult.isError).toBeFalsy();

    const greetResult = await fake.invoke("tools/call", {
      params: { name: "greet", arguments: { name: "Bob" } },
    });
    expect(greetResult.isError).toBe(true);
    expect(greetResult.content[0].text).toContain("not authorized");
  });
});

// ---------------------------------------------------------------------------
// serveAgent — error terminal → isError (Finding #5 Low)
// ---------------------------------------------------------------------------

describe("serveAgent — error terminal isError", () => {
  it("success terminal → isError falsy", async () => {
    const successAgent: AgentLike = {
      async *query(input: string) {
        yield { type: "result", subtype: "success", output: `done: ${input}`, usage: {}, numTurns: 1, sessionId: "s1" };
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "ok_agent", successAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "ok_agent", arguments: { input: "hi" } },
    });
    expect(result.isError).toBeFalsy();
  });

  it("error terminal → isError:true", async () => {
    const errorAgent: AgentLike = {
      async *query() {
        yield { type: "result", subtype: "error", usage: {}, numTurns: 1, sessionId: "s1" };
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "err_agent", errorAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "err_agent", arguments: { input: "go" } },
    });
    expect(result.isError).toBe(true);
  });

  it("aborted terminal → isError:true", async () => {
    const abortedAgent: AgentLike = {
      async *query() {
        yield { type: "result", subtype: "aborted", usage: {}, numTurns: 1, sessionId: "s1" };
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "aborted_agent", abortedAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "aborted_agent", arguments: { input: "" } },
    });
    expect(result.isError).toBe(true);
  });

  it("guardrail terminal → isError:true", async () => {
    const guardrailAgent: AgentLike = {
      async *query() {
        yield { type: "result", subtype: "guardrail", usage: {}, numTurns: 1, sessionId: "s1" };
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "guardrail_agent", guardrailAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "guardrail_agent", arguments: { input: "" } },
    });
    expect(result.isError).toBe(true);
  });

  it("max_turns terminal → isError:true", async () => {
    const maxTurnsAgent: AgentLike = {
      async *query() {
        yield { type: "result", subtype: "max_turns", usage: {}, numTurns: 10, sessionId: "s1" };
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "max_turns_agent", maxTurnsAgent);

    const result = await fake.invoke("tools/call", {
      params: { name: "max_turns_agent", arguments: { input: "" } },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// authenticateConnection hook (H4 — transport-level auth)
// ---------------------------------------------------------------------------

describe("serveTools — authenticateConnection hook", () => {
  it("receives SDK transport metadata rather than mistaking protocol params for auth context", async () => {
    const fake = new FakeMcpServer();
    const seen: unknown[] = [];
    serveTools(fake, [addTool], {
      authenticateConnection: (context) => {
        seen.push(context);
        return { principal: { subject: "trusted-client" } };
      },
    });

    const request = { params: { name: "add", arguments: { a: 1, b: 2 } } };
    const extra = {
      authInfo: { clientId: "transport-client" },
      requestInfo: { headers: { authorization: "Bearer transport-token" } },
    };
    const result = await fake.invoke("tools/call", request, extra);

    expect(result.isError).toBeFalsy();
    expect(seen).toEqual([
      expect.objectContaining({ request, transport: extra, authInfo: extra.authInfo, requestInfo: extra.requestInfo }),
    ]);
  });

  it("passes only the authenticated principal to authorization, context creation, and audit", async () => {
    const fake = new FakeMcpServer();
    const principal = { subject: "verified-user" };
    const seen: { authorize?: unknown; context?: unknown; audit?: unknown } = {};
    const events: Array<{ principal?: unknown }> = [];
    serveTools(fake, [addTool], {
      authenticateConnection: () => ({ principal }),
      authorize: (_name, _input, context) => {
        seen.authorize = context.principal;
        return true;
      },
      ctxFactory: (context) => {
        seen.context = context.principal;
        return {};
      },
      onAudit: (event) => events.push(event),
    });

    await fake.invoke(
      "tools/call",
      { params: { name: "add", arguments: { a: 4, b: 5 } } },
      { authInfo: { clientId: "transport-client" } },
    );

    seen.audit = events[0]?.principal;
    expect(seen).toEqual({ authorize: principal, context: principal, audit: principal });
  });

  it("does not expose raw SDK auth credentials to downstream hooks or audit", async () => {
    const fake = new FakeMcpServer();
    const contexts: unknown[] = [];
    const events: Array<{ principal?: unknown }> = [];
    serveTools(fake, [addTool], {
      authorize: (_name, _input, context) => {
        contexts.push(context);
        return true;
      },
      ctxFactory: (context) => {
        contexts.push(context);
        return {};
      },
      onAudit: (event) => events.push(event),
    });

    await fake.invoke(
      "tools/call",
      { params: { name: "add", arguments: { a: 2, b: 3 } } },
      {
        authInfo: {
          token: "transport-secret-token",
          clientId: "safe-client",
          scopes: ["tools:call"],
        },
        requestInfo: { headers: { authorization: "Bearer request-info-secret" } },
      },
    );

    expect(contexts).toEqual([
      { request: expect.any(Object), principal: { clientId: "safe-client", scopes: ["tools:call"] } },
      { request: expect.any(Object), principal: { clientId: "safe-client", scopes: ["tools:call"] } },
    ]);
    const serialized = JSON.stringify({ contexts, events });
    expect(serialized).not.toContain("transport-secret-token");
    expect(serialized).not.toContain("request-info-secret");
  });

  it("option omitted → tools/list succeeds (unchanged behaviour)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]);

    const result = await fake.invoke("tools/list");
    expect(result.tools).toHaveLength(1);
    expect(result.isError).toBeFalsy();
  });

  it("option omitted → tools/call succeeds (unchanged behaviour)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool]);

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("3");
  });

  it("authenticateConnection returning false → tools/list rejected with auth error", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authenticateConnection: () => false });

    const result = await fake.invoke("tools/list");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authenticated");
  });

  it("treats an empty authentication result object as a denial", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      // Runtime regression: JavaScript callers can still return an object that
      // does not contain the required principal field.
      authenticateConnection: () => ({} as { principal: unknown }),
    });

    const result = await fake.invoke("tools/list");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authenticated");
  });

  it("authenticateConnection returning false → tools/call rejected with auth error", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authenticateConnection: () => false });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authenticated");
  });

  it("authenticateConnection that throws → rejected (treated as denial)", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authenticateConnection: () => { throw new Error("auth service down"); },
    });

    const result = await fake.invoke("tools/list");
    expect(result.isError).toBe(true);
  });

  it("authenticateConnection returning true → normal tools/list flow", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, greetTool], { authenticateConnection: () => true });

    const result = await fake.invoke("tools/list");
    expect(result.isError).toBeFalsy();
    expect(result.tools).toHaveLength(2);
  });

  it("authenticateConnection returning true → normal tools/call flow", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authenticateConnection: () => true });

    const result = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 10, b: 5 } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("15");
  });

  it("async authenticateConnection returning false → rejected", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], { authenticateConnection: async () => false });

    const result = await fake.invoke("tools/list");
    expect(result.isError).toBe(true);
  });

  it("authenticateConnection is called before authorize (auth denied, authorize never called)", async () => {
    const authorizeCalls: string[] = [];
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool], {
      authenticateConnection: () => false,
      authorize: (name) => { authorizeCalls.push(name); return true; },
    });

    await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 1, b: 2 } },
    });
    expect(authorizeCalls).toHaveLength(0);
  });

  it("both authenticateConnection and authorize must pass for a call to succeed", async () => {
    const fake = new FakeMcpServer();
    serveTools(fake, [addTool, greetTool], {
      authenticateConnection: () => true,
      authorize: (name) => name === "add",
    });

    const addResult = await fake.invoke("tools/call", {
      params: { name: "add", arguments: { a: 3, b: 3 } },
    });
    expect(addResult.isError).toBeFalsy();

    const greetResult = await fake.invoke("tools/call", {
      params: { name: "greet", arguments: { name: "Eve" } },
    });
    expect(greetResult.isError).toBe(true);
    expect(greetResult.content[0].text).toContain("not authorized");
  });
});

describe("serveAgent — trusted identity", () => {
  it("ignores caller-supplied identity fields by default", async () => {
    let captured: unknown;
    const agent: AgentLike = {
      async query(_input, options) {
        captured = options;
        return "ok";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent);

    const listed = await fake.invoke("tools/list");
    expect(listed.tools[0].inputSchema.properties).not.toHaveProperty("userId");
    expect(listed.tools[0].inputSchema.properties).not.toHaveProperty("orgId");
    expect(listed.tools[0].inputSchema.properties).not.toHaveProperty("apiKey");

    await fake.invoke("tools/call", {
      params: {
        name: "agent",
        arguments: { input: "hello", userId: "spoofed", orgId: "spoofed-org", apiKey: "secret" },
      },
    });
    expect(captured).toEqual(expect.objectContaining({ sessionId: expect.any(String) }));
    expect(captured).not.toEqual(expect.objectContaining({ userId: expect.anything() }));
    expect(captured).not.toEqual(expect.objectContaining({ orgId: expect.anything() }));
    expect(captured).not.toEqual(expect.objectContaining({ apiKey: expect.anything() }));
  });

  it("maps a verified transport principal to agent identity through an explicit trusted hook", async () => {
    let captured: unknown;
    const agent: AgentLike = {
      async query(_input, options) {
        captured = options;
        return "ok";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent, "Agent", {
      authenticateConnection: () => ({ principal: { subject: "verified-user" } }),
      agentIdentity: (principal) => ({ userId: (principal as { subject: string }).subject }),
    });

    await fake.invoke(
      "tools/call",
      { params: { name: "agent", arguments: { input: "hello", userId: "spoofed" } } },
      { authInfo: { clientId: "transport-client" } },
    );
    expect(captured).toEqual(expect.objectContaining({ userId: "verified-user" }));
  });

  it("binds a verified SDK clientId to a stable credential-free agent identity by default", async () => {
    let captured: unknown;
    const agent: AgentLike = {
      async query(_input, options) {
        captured = options;
        return "ok";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent);

    await fake.invoke(
      "tools/call",
      { params: { name: "agent", arguments: { input: "hello", sessionId: "shared" } } },
      { authInfo: { token: "never-persist", clientId: "verified-client", scopes: [] } },
    );

    expect(captured).toEqual({
      sessionId: "shared",
      userId: "mcp-client:verified-client",
    });
    expect(JSON.stringify(captured)).not.toContain("never-persist");
  });

  it("denies an authenticated agent call when no stable principal identity is available", async () => {
    let calls = 0;
    const agent: AgentLike = {
      async query() {
        calls++;
        return "should not run";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent, "Agent", {
      authenticateConnection: () => true,
    });

    const result = await fake.invoke("tools/call", {
      params: { name: "agent", arguments: { input: "hello" } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/identity|principal/i);
    expect(calls).toBe(0);
  });

  it("applies per-call authorization before invoking a directly served agent", async () => {
    let calls = 0;
    const agent: AgentLike = {
      async query() {
        calls++;
        return "should not run";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent, "Agent", {
      authorize: () => false,
    });

    const result = await fake.invoke("tools/call", {
      params: { name: "agent", arguments: { input: "hello" } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authorized");
    expect(calls).toBe(0);
  });

  it("keeps the legacy identity fields behind an explicit unsafe compatibility opt-in", async () => {
    let captured: unknown;
    const agent: AgentLike = {
      async query(_input, options) {
        captured = options;
        return "ok";
      },
    };
    const fake = new FakeMcpServer();
    serveAgent(fake, "agent", agent, "Agent", { allowUntrustedIdentityArgs: true });

    await fake.invoke("tools/call", {
      params: { name: "agent", arguments: { input: "hello", userId: "legacy-user" } },
    });
    expect(captured).toEqual(expect.objectContaining({ userId: "legacy-user" }));
  });
});

// ---------------------------------------------------------------------------
// Gated live-SDK test (skipped unless EIDENTIC_TEST_MCP_SERVER_LIVE=1)
// ---------------------------------------------------------------------------
const live = process.env["EIDENTIC_TEST_MCP_SERVER_LIVE"] === "1" ? describe : describe.skip;

live("createMcpServer — live SDK round-trip (EIDENTIC_TEST_MCP_SERVER_LIVE=1)", () => {
  it("registers tools via the real SDK Server and tools/list resolves", async () => {
    // Dynamically import to avoid SDK import errors when the peer is absent.
    const { createMcpServer } = await import("../src/server.js");
    const { server } = await createMcpServer([addTool, greetTool], {
      name: "test-server",
      version: "0.0.0",
    });
    expect(server).toBeDefined();
    await server.close();
  }, 30_000);
});
