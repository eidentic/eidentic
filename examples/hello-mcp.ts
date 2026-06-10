/**
 * MCP host (§5.5): connect to an MCP server, expose its tools as first-class Eidentic tools,
 * and dispatch them through the normal ToolRegistry loop. Infra-free: the MCP client is an
 * in-memory fake (swap for `stdioClient(...)` / `streamableHttpClient(...)` in production).
 *
 * Run:  pnpm hello:mcp
 */
import { ToolRegistry } from "@eidentic/core";
import { mcpTools, type McpClientLike } from "@eidentic/mcp";

// A stand-in MCP server: one read-only tool (echo) and one destructive tool (write_note).
const fakeClient: McpClientLike = {
  async listTools() {
    return {
      tools: [
        {
          name: "echo",
          description: "Echo a message.",
          inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
          annotations: { readOnlyHint: true },
        },
        {
          name: "write_note",
          description: "Persist a note (side-effecting).",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
      ],
    };
  },
  async callTool({ name, arguments: args }) {
    if (name === "echo") return { content: [{ type: "text", text: `echo: ${(args as { message: string }).message}` }] };
    return { content: [{ type: "text", text: `saved: ${(args as { text: string }).text}` }] };
  },
};

async function main() {
  // 1. Wrap the MCP server's tools as first-class Eidentic tools (with an `mcp` namespace prefix).
  const tools = await mcpTools(fakeClient, { prefix: "mcp" });
  for (const t of tools) console.log(`tool ${t.id.padEnd(18)} sideEffect=${t.sideEffect}`);
  //  → tool mcp__echo         sideEffect=read-only      (readOnlyHint:true)
  //  → tool mcp__write_note   sideEffect=destructive    (unannotated → §5.5 safe default)

  // 2. They dispatch through a normal ToolRegistry exactly like native tools.
  const registry = new ToolRegistry(tools);
  const [readResult] = await registry.dispatch([{ callId: "1", name: "mcp__echo", input: { message: "hello from MCP" } }]);
  console.log("[read-only]  ", readResult!.output);    // → echo: hello from MCP

  const [writeResult] = await registry.dispatch([{ callId: "2", name: "mcp__write_note", input: { text: "ship v13b" } }]);
  console.log("[destructive]", writeResult!.output);   // → saved: ship v13b

  // 3. In a real agent, pass `tools` (or `[...nativeTools, ...tools]`) into the Agent's registry;
  //    the model invokes them via the same tool-call loop. To connect a real server instead:
  //      import { stdioClient } from "@eidentic/mcp";
  //      const client = await stdioClient({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] });
  //      const tools = await mcpTools(client, { prefix: "mcp" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
