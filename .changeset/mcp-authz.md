---
"@eidentic/mcp": minor
---

Close MCP server authorization gap (security hardening).

**Finding #5 High — per-call authorization & destructive-tool opt-in:**

- `serveTools`, `mcpServer`, and `createMcpServer` now accept an `authorize?(toolName, input): boolean | Promise<boolean>` hook. When set, it is called before every `tools/call` dispatch; returning `false` (or throwing) yields `isError: true` without executing the tool. Default behaviour (hook absent) is unchanged for back-compat.

- Tools with `sideEffect: "destructive"` (e.g. `bashTool`, agent-as-tool) are **skipped by default** — they will not appear in `tools/list` and cannot be called. A `console.warn` is emitted for each skipped tool. Opt in explicitly via `allowDestructive: true` or by providing an `authorize` hook. This is a **safe-by-default breaking change** for callers that pass destructive tools: add `allowDestructive: true` (or an `authorize` hook) to restore the previous behaviour.

- Added `allowDestructive?: boolean` to `McpServerOptions` (inherited by all builders).

**Finding #5 Low — agent error terminals:**

- `serveAgent`: when the final streamed event is `{ type: "result", subtype: <non-success> }` (e.g. `"error"`, `"aborted"`, `"guardrail"`, `"max_turns"`, etc.), the MCP response is now returned with `isError: true` instead of a normal content block. In `mcpServer({agent})`, the synthesized agent tool throws for non-success terminals so the common handler surfaces them as `isError: true`.

**Restrictive ctx & loud docs:**

- `ctxFactory` JSDoc updated to clearly state that the default empty context `{}` grants no permissions, no scope, no secrets, and no sandbox — callers must override to inject security context.
- JSDoc on all public server functions (`serveTools`, `serveAgent`, `mcpServer`, `createMcpServer`) now prominently states: no authentication, no per-call authorization by default, and that the HTTP transport must be placed behind the caller's own auth middleware.
