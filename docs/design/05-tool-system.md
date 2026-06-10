# 5. Tool System

[← 4. Context Engine](04-context-engine.md) · [Index](master-design.md) · Next: [6. Memory Engine →](06-memory-engine.md)

Tools are how agents act. The research is blunt: every additional tool degrades model
performance on *all* tasks (Berkeley Function-Calling Leaderboard), and unsealed tools are
the attack surface for the lethal trifecta. The tool system optimizes for **few, well-typed,
permission-gated, lazily-discoverable** tools.

## 5.1 Three separated concerns

A production lesson (arXiv:2603.05344): separate what a tool *is*, its *schema*, and its
*dispatch*.

1. **Definition** — semantic description + handler (`createTool`).
2. **Schema generation** — JSON Schema derived from the input/output Standard-Schema,
   filtered per-agent and per-turn (a tool the model can't see can't be misused).
3. **Runtime dispatch** — a `ToolRegistry` that validates, gates, sandboxes, executes, and
   truncates — with the handler unaware of agent-level concerns (dependency injection).

## 5.2 The Tool contract

```ts
const refund = createTool({
  id: 'refund_order',
  description: 'Issue a refund for an order. Side-effecting and irreversible.',
  inputSchema:  z.object({ orderId: z.string(), amountCents: z.number().int().positive() }),
  outputSchema: z.object({ refundId: z.string() }),
  // idempotencyKey MUST include the args, never just an entity id (a partial refund and a full
  // refund for the same order are different operations). Best: a caller-supplied request id.
  annotations: { sideEffect: 'destructive', idempotencyKey: (i, ctx) => ctx.requestId ?? `${i.orderId}:${i.amountCents}`, costHint: 'low' },
  execute: async ({ input, ctx }) => ctx.deps.billing.refund(input.orderId, input.amountCents),
})
```

- **`annotations.sideEffect`**: `read-only | idempotent | destructive`. This single field
  drives three subsystems: permissions (destructive ⇒ deny-by-default + human-gate),
  scheduling (read-only ⇒ parallelizable), and durability (idempotent/destructive ⇒
  idempotency-key required, §9). Modeled on MCP tool annotations + standard tool-safety classification.
- **`ctx`** carries injected dependencies, the session, an `AbortSignal`, and a scoped
  logger/tracer — never global state.
- Schemas use **Standard Schema** so Zod/Valibot/ArkType all work and JSON Schema is
  generated uniformly.

## 5.3 Dispatch semantics

```
dispatchToolCalls(calls):
  partition calls by annotations.sideEffect
  run read-only calls CONCURRENTLY (FuturesOrdered-style, preserve order in results)
  run idempotent/destructive calls SERIALLY, each:
    1. validate input  → on fail: repair pass (§3.7)
    2. permission gate (deny-by-default; destructive → human-gate unless pre-approved)
    3. stale-read check (if tool declares file/resource reads, verify unchanged since read)
    4. durability: compute idempotencyKey; skip if already-applied on resume (§9)
    5. sandbox if tool is untrusted/generated code (§10)
    6. execute with per-tool timeout + AbortSignal
    7. truncate output to return-char limit; offload overflow (§4.5)
    8. emit tool.result event + OTel span (input, output, timing, cost)
```

Read-only parallelism is a major latency win; serial mutation prevents write conflicts and
makes idempotency tractable.

## 5.4 Lazy tool discovery (context-cost control)

Preloading every tool/MCP schema can burn tens of thousands of tokens before any work
(dynamic loading cuts this overhead by ~94%). The registry supports two
meta-tools when the active toolset is large:

- **`search_tools(query)`** → keyword/embedding-scored top-k tool *signatures* (name +
  one-line desc), not full schemas.
- **`load_tool(name)`** → injects the full schema for a selected tool into the manifest
  (append-only, cache-friendly).

Small toolsets (≤ ~20) are loaded eagerly. Above a threshold, discovery is lazy. The engine
keeps the eagerly-loaded core to ~20 atomic tools (`bash`, file ops, navigation, memory,
skills) and lets the rest be discovered — matching the "hierarchical action space" finding.

## 5.5 MCP: host and server

`@eidentic/mcp` makes Eidentic both:

- **MCP host** — connect to external MCP servers and expose their tools as first-class
  Eidentic tools. Transports: **Streamable HTTP** (default, stateless, load-balancer-friendly),
  SSE (legacy), stdio (local dev). OAuth 2.1 + PKCE + Resource Indicators (RFC 8707) for
  remote servers, mandatory. Per-server diagnostics (reconnect, list-with-errors, stderr)
  and per-tool approval flags.
- **MCP server** — expose an agent's own tools/skills/memory to other MCP clients, so a
  Eidentic agent is consumable by compatible agent tools and MCP clients.

MCP tools inherit the annotation model: a server's `readOnlyHint` maps to `read-only`
(parallelizable); unannotated remote tools default to `destructive` (safe).

## 5.6 Sealed tool endpoints (security)

Per the lethal-trifecta research, agents must **not** author raw network calls. Tools are
*sealed*: fixed schemas, fixed endpoints. The agent supplies typed parameters; it cannot
alter URLs, headers, auth, or method. A generic `http_request` tool is **not** shipped by
default; outbound access is via specific sealed tools with egress allowlisting (§10).
Credentials are injected by the dispatcher from a vault — the model never sees secrets.

## 5.7 Human-in-the-loop suspension

A tool can suspend for human input/approval and resume durably:

```ts
execute: async ({ input, ctx }) => {
  if (input.amountCents > 10_000) {
    const decision = await ctx.suspend({ reason: 'large refund approval', present: input })
    if (!decision.approved) return ctx.fail('declined')
  }
  return ctx.deps.billing.refund(...)
}
```

Suspension persists the run (§9) and consumes no compute while waiting; resume injects the
human decision. This is the substrate for the permission "ask" decision (§3.5) and
destructive-action gates (§10).

## 5.8 Built-in tool set (the ~20 atomic core)

Files (`read`, `write`, `edit`, `glob`, `grep`), shell (`bash`, sandboxed), web
(`web_search`, `web_fetch` — sealed), memory (`memory_*`, §6), skills (`skill_use`,
`skill_search`, §7), sub-agents (`spawn_agent`, §8), and discovery (`search_tools`,
`load_tool`). Mirrors the atomic core of leading coding agents; everything else is a user tool, MCP tool, or skill.

## 5.9 Traceability

- Tool sprawl degrading models → §5.4 lazy discovery + ~20 atomic core.
- Lethal trifecta / prompt injection → §5.6 sealed endpoints + credential isolation (§10).
- Tool-loop flakiness → §5.3 validate+repair+stale-read; per-tool caps (§3.4).
- Resume duplicating side effects → §5.3 step 4 idempotency keys (§9).
