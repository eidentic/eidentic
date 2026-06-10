---
"@eidentic/mcp": minor
---

New `@eidentic/mcp` package (design §5.5, host side): connect to external MCP servers and expose
their tools as first-class Eidentic `Tool`s, so the existing `ToolRegistry` / agent loop dispatch
them unchanged. `mcpTools(client, opts?)` takes an already-connected client (injected-client
pattern — it opens no connection itself), lists the server's tools, and wraps each: the MCP
`inputSchema` passes through as the Eidentic `jsonSchema`, `parse` is a pass-through (the server
validates args), and `execute` calls `callTool` and maps the result. The §5.5 annotation invariant
is enforced: a server's `readOnlyHint:true` → `"read-only"` (parallelizable); any unannotated
remote tool → `"destructive"` (safe default — deny-by-default + human-gate). An MCP `isError:true`
is surfaced as a Eidentic tool error. Ergonomic transport helpers `streamableHttpClient(url, opts?)`
(default; static auth headers via `requestInit`) and `stdioClient({ command, args, env })` (local
dev) construct + connect a real client. Conformance runs in CI against a faithful in-memory fake
(incl. end-to-end dispatch through a real `ToolRegistry`); a gated live test
(`EIDENTIC_TEST_MCP_STDIO_COMMAND`) covers a real stdio server. Runtime deps are only `@eidentic/core`
+ `@eidentic/types`; `@modelcontextprotocol/sdk` is an optional peer dependency.

Deferred (not in this release): the MCP **server** side (exposing a Eidentic agent as an MCP server);
OAuth 2.1 + PKCE + Resource Indicators auth for remote servers (the Streamable HTTP transport
accepts static auth headers, but the full OAuth flow is deferred); lazy tool discovery
(`search_tools` / `load_tool`, §5.4); the legacy SSE transport.
