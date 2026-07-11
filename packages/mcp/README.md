# @eidentic/mcp

Model Context Protocol (MCP) host and server for Eidentic — expose an agent or any set of
Eidentic tools as an MCP server that any MCP-compatible client can call, or consume a
remote MCP server's tools as first-class Eidentic tools. Includes a full OAuth 2.1 + PKCE
client for authenticated MCP connections.

## Install

```bash
pnpm add @eidentic/mcp
```

## Usage

### Expose tools as an MCP server

```ts
import { createMcpServer } from "@eidentic/mcp";
import { fileTools } from "@eidentic/tools";

// Requires optional peer: pnpm add @modelcontextprotocol/sdk
const handle = await createMcpServer(
  fileTools({ root: process.cwd() }),
  {
    name: "my-tools",
    version: "1.0.0",
    authenticateConnection: async (context) => {
      const principal = await verifyTransportContext(context.requestInfo);
      return principal ? { principal } : false;
    },
    authorize: (toolName, _input, { principal }) => canCall(principal, toolName),
  },
);

await handle.serveStdio(); // blocks — wire into stdio transport
```

MCP protocol parameters are never treated as authentication context. Agent tools also ignore
caller-supplied `userId`, `orgId`, and `apiKey` fields by default. A verified principal containing
`userId`/`orgId` (or a stable `id`, `subject`, or `sub`) is mapped to the agent identity. SDK
connections without an application principal use their verified MCP `clientId`; raw credentials
are never forwarded. Use `agentIdentity` for application-specific mapping. Authenticated agent
calls without a stable identity are denied; `allowUntrustedIdentityArgs: true` exists only for
legacy migration.

Both `createMcpServer` and the direct `serveAgent` helper accept `authorize`, which runs after
authentication and before `Agent.query`.

Streamable HTTP is fail-closed unless `authenticateConnection` is configured. The explicit
`allowUnauthenticatedHttp: true` escape hatch is for isolated local development only; stdio is
unchanged.

### Consume a remote MCP server's tools

```ts
import { mcpTools } from "@eidentic/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "eidentic", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: "npx", args: ["my-mcp-server"] }));

const tools = await mcpTools(client);
const agent = new Agent({ id: "agent", model, store, tools });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
