import { describe, it, expect } from "vitest";
import { mcpTools } from "../src/index.js";
import { stdioClient } from "../src/index.js";

/**
 * Hits a REAL MCP server over stdio. SKIPPED unless EIDENTIC_TEST_MCP_STDIO_COMMAND is set.
 * Never runs in CI.
 * Local (uses the official everything server, which has an `echo` tool):
 *   EIDENTIC_TEST_MCP_STDIO_COMMAND=npx \
 *   EIDENTIC_TEST_MCP_STDIO_ARGS='-y,@modelcontextprotocol/server-everything' \
 *   pnpm --filter @eidentic/mcp test live
 */
const command = process.env["EIDENTIC_TEST_MCP_STDIO_COMMAND"];
const args = (process.env["EIDENTIC_TEST_MCP_STDIO_ARGS"] ?? "").split(",").filter(Boolean);
const live = command ? describe : describe.skip;

live("mcpTools over a live stdio MCP server", () => {
  it("lists and wraps real tools, then invokes one end-to-end", async () => {
    const client = await stdioClient({ command: command!, args });
    const tools = await mcpTools(client, { prefix: "live" });
    expect(tools.length).toBeGreaterThan(0);
    const echo = tools.find((t) => t.id.endsWith("__echo"));
    expect(echo).toBeDefined();
    const out = await echo!.execute({ message: "eidentic" });
    expect(String(out)).toContain("eidentic");
  }, 60_000);
});
