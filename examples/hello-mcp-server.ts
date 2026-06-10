/**
 * MCP server side (§5.5 inverse): expose Eidentic tools AS an MCP server so any
 * MCP client (Claude Desktop, other agents) can call them. Infra-free demo: uses
 * the structural `McpServerLike` fake to call handlers directly (swap for
 * `createMcpServer` + `serveStdio()` / `serveHttp()` in production).
 *
 * Run:  pnpm hello:mcp-server
 */
import { z } from "zod";
import { createTool } from "@eidentic/core";
import { serveTools, type McpServerLike } from "@eidentic/mcp";

// ---------------------------------------------------------------------------
// 1. Define two Eidentic tools.
// ---------------------------------------------------------------------------
const addTool = createTool({
  id: "add",
  description: "Add two integers and return their sum.",
  inputSchema: z.object({ a: z.number().int(), b: z.number().int() }),
  execute: async ({ input }) => ({ result: input.a + input.b }),
});

const upperCaseTool = createTool({
  id: "upper_case",
  description: "Convert a string to upper-case.",
  inputSchema: z.object({ text: z.string() }),
  sideEffect: "read-only",
  execute: async ({ input }) => input.text.toUpperCase(),
});

// ---------------------------------------------------------------------------
// 2. In-memory structural fake — records handlers, lets us invoke them directly.
//    (The real SDK Server satisfies the same McpServerLike interface.)
// ---------------------------------------------------------------------------
class FakeMcpServer implements McpServerLike {
  private handlers = new Map<string, (req: any) => Promise<any>>();
  setRequestHandler(schema: unknown, handler: (req: any) => Promise<any>) {
    this.handlers.set(String(schema), handler);
  }
  async invoke(method: string, req: unknown = {}) {
    const h = this.handlers.get(method);
    if (!h) throw new Error(`no handler for '${method}'`);
    return h(req);
  }
  async connect(_transport: unknown) {}
  async close() {}
}

async function main() {
  const fake = new FakeMcpServer();

  // 3. Register the Eidentic tools onto the fake MCP server.
  serveTools(fake, [addTool, upperCaseTool]);

  // 4. Simulate tools/list — what any MCP client would call first.
  const { tools } = await fake.invoke("tools/list");
  console.log("=== tools/list ===");
  for (const t of tools) {
    console.log(` • ${t.name}: ${t.description}`);
    console.log(`   inputSchema: ${JSON.stringify(t.inputSchema)}`);
  }

  // 5. Simulate tools/call — "add" tool.
  console.log("\n=== tools/call: add({ a: 7, b: 35 }) ===");
  const addResult = await fake.invoke("tools/call", {
    params: { name: "add", arguments: { a: 7, b: 35 } },
  });
  console.log("  isError:", addResult.isError ?? false);
  console.log("  content:", addResult.content);
  // → content: [{ type: 'text', text: '{"result":42}' }]

  // 6. Simulate tools/call — "upper_case" tool.
  console.log("\n=== tools/call: upper_case({ text: 'hello mcp server' }) ===");
  const ucResult = await fake.invoke("tools/call", {
    params: { name: "upper_case", arguments: { text: "hello mcp server" } },
  });
  console.log("  isError:", ucResult.isError ?? false);
  console.log("  content:", ucResult.content);
  // → content: [{ type: 'text', text: '"HELLO MCP SERVER"' }]

  // 7. Simulate an error case — unknown tool.
  console.log("\n=== tools/call: unknown tool (error path) ===");
  const errResult = await fake.invoke("tools/call", {
    params: { name: "nonexistent", arguments: {} },
  });
  console.log("  isError:", errResult.isError);
  console.log("  content:", errResult.content);

  // 8. In production, connect to a real transport instead:
  //
  //   import { createMcpServer } from "@eidentic/mcp";
  //   const { serveStdio } = await createMcpServer([addTool, upperCaseTool], {
  //     name: "my-eidentic-server", version: "1.0.0",
  //   });
  //   await serveStdio(); // wire into Claude Desktop or any stdio MCP client
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
