---
"@eidentic/mcp": minor
---

MCP server side (§5.5 inverse): expose Eidentic tools and agents AS an MCP server so any MCP client
(Claude Desktop, other agents) can call them via `tools/list` + `tools/call`.

`serveTools(server, tools, opts?)` — structural seam (takes `McpServerLike`, not the raw SDK `Server`)
that registers handlers onto any compatible server instance. The `McpServerLike` interface is
satisfied by the real SDK `Server` and by the faithful in-memory fake used in CI, keeping the module
SDK-free at import time. Each Eidentic tool is advertised as `{ name: tool.id, description,
inputSchema: tool.jsonSchema }` — the JSON Schema is the one `createTool` already computes via
`z.toJSONSchema`, so no re-conversion is needed. `tools/call` validates arguments through the tool's
own `parse`, executes via `tool.execute({ input, ctx })`, and returns the result as
`{ content: [{ type:"text", text: JSON.stringify(result) }] }`. All error paths (unknown tool, parse
failure, thrown error) return `{ isError: true }` — the handler never throws.

`serveAgent(server, agentId, agent, description?)` — expose a Eidentic `Agent` as a single MCP tool
whose call runs `agent.query(input)` to completion and returns the final output text.

`mcpServer(opts)` (§5.5 D4) — primary entry-point with opts-style API: `opts.tools` (required)
plus optional `agent`/`agentId`/`agentDescription` to expose an agent as an extra MCP tool. Returns
an `McpServerHandle` with `serveStdio()` and `serveHttp()` transport helpers.

`createMcpServer(tools, opts?)` — positional-args builder (kept for back-compat); `mcpServer` is
preferred for new code. Both dynamically import the SDK `Server` and expose `serveStdio()` (for
claude_desktop stdio servers) and `serveHttp(opts?)` (Streamable HTTP, stateless or stateful).
Dynamic import + actionable error if the SDK peer is missing, mirroring the host-side helpers.

Conformance: faithful in-memory `FakeMcpServer` in `test/server.test.ts` covers `tools/list`,
`tools/call` (happy + error paths), `serveAgent`, and verifies no handler ever throws. Full SDK
round-trip in `test/inmemory-roundtrip.test.ts` uses `InMemoryTransport.createLinkedPair()` from
`@modelcontextprotocol/sdk/inMemory.js` to wire a real Client ↔ Server in-process — covering
`listTools`, `callTool` (success + error + unknown tool), and the opts-style `mcpServer` API
including agent exposure. A gated live-SDK test is included but skipped unless
`EIDENTIC_TEST_MCP_SERVER_LIVE=1`.

Runtime deps unchanged (`@eidentic/core` + `@eidentic/types` only); `@modelcontextprotocol/sdk`
stays an optional peer dependency. OAuth/full-transport hardening deferred.
