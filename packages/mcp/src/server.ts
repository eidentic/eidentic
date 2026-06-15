import type { Tool } from "@eidentic/core";
import type { ToolContext } from "@eidentic/core";
import type { TracerPort } from "@eidentic/types";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Structural interface — the minimal MCP server surface `serveTools` drives.
// The real `@modelcontextprotocol/sdk` `Server` satisfies this; tests inject
// a faithful in-memory fake instead. This keeps the module SDK-free at import
// time (mirrors how McpClientLike decouples the host side).
// ---------------------------------------------------------------------------

/**
 * Minimal structural subset of the MCP SDK `Server` that `serveTools` drives.
 * Satisfied by the real SDK `Server` and by the in-memory fake used in tests.
 */
export interface McpServerLike {
  setRequestHandler(schema: unknown, handler: (req: any) => Promise<any>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * Audit event emitted for every handled MCP request (governance posture: full audit trail
 * including denials, parse failures, and handler errors — not just successful calls).
 *
 * Fields:
 * - `method` — the MCP method that was invoked (`"tools/list"` or `"tools/call"`).
 * - `toolName` — the tool name from the request (only present for `tools/call`).
 * - `principal` — opaque context from `authenticateConnection` or the raw request object,
 *   whichever is available. Cast to your auth context type to extract identity information.
 * - `startedAt` — wall-clock timestamp (ms since epoch) when the handler was entered.
 * - `durationMs` — handler wall-clock duration in milliseconds.
 * - `outcome` — `"ok"` for successful calls, `"denied"` for auth/authz rejections, `"error"` for
 *   tool parse failures and execution errors.
 * - `errorMessage` — human-readable error string when `outcome` is `"denied"` or `"error"`.
 */
export interface McpAuditEvent {
  method: "tools/list" | "tools/call";
  toolName?: string;
  /** Whatever context was available on the raw request (connection context or raw req). */
  principal?: unknown;
  startedAt: number;
  durationMs: number;
  outcome: "ok" | "denied" | "error";
  errorMessage?: string;
}

export interface McpServerOptions {
  name?: string;
  version?: string;

  /**
   * Transport-level authentication hook. When provided, this callback is invoked BEFORE any
   * MCP handler runs — including `tools/list`. If it returns `false` or throws, the request is
   * rejected immediately with an MCP error result and no handler is dispatched.
   *
   * Use this to enforce connection-level access control, e.g. validating a bearer token embedded
   * in a request header, checking a shared secret, or verifying a session cookie.
   *
   * The callback receives whatever `connectionContext` the transport makes available. For the
   * structural fake used in tests the value is whatever the test passes as the second argument
   * to `invoke`; for real transports it is the raw request object (or `undefined` for stdio).
   *
   * **Fully back-compat:** when this option is not set, all requests are allowed through
   * unchanged — existing behaviour is preserved.
   *
   * **Note:** per-call `authorize` still applies on top of `authenticateConnection`. A request
   * must pass transport-level authentication first, then each individual `tools/call` is gated
   * by `authorize` (if provided).
   *
   * @example
   * ```ts
   * authenticateConnection: (ctx) => {
   *   const token = (ctx as Request)?.headers?.get("authorization") ?? "";
   *   return token === `Bearer ${process.env.MCP_SECRET}`;
   * }
   * ```
   */
  authenticateConnection?: (connectionContext: unknown) => boolean | Promise<boolean>;

  /**
   * Factory for the `ToolContext` passed to each `tool.execute` call.
   *
   * **Security note:** the default (unset) produces an empty context `{}`, which grants NO
   * permissions, NO scope, NO secrets injection, and NO sandbox. If your tools rely on
   * `ctx.policy`, `ctx.secrets`, or a sandbox, you MUST provide a `ctxFactory` that populates
   * those fields — otherwise the tool will run with no access controls at the execution layer.
   *
   * Override this to inject scope, a `PermissionPolicy`, secrets, or a custom `AbortSignal`.
   * Example:
   * ```ts
   * ctxFactory: () => ({ policy: myPermissionPolicy, secrets: mySecretsPort })
   * ```
   */
  ctxFactory?: () => ToolContext;

  /**
   * Per-call authorization hook. Called before every `tools/call` dispatch with the tool name
   * and raw (unparsed) input. Return `true` to allow the call; return `false` (or a rejected
   * promise) to reject it with an MCP error result (`isError: true`).
   *
   * When not set, ALL registered tools may be called by any connected client — there is no
   * per-call authorization. Use this hook to enforce fine-grained access control, e.g. based on
   * the calling client's identity, the requested tool, or the call arguments.
   *
   * **Important:** this hook is NOT a substitute for transport-level authentication. You must
   * put the HTTP transport behind your own auth middleware (e.g. `Authorization` header check,
   * session validation) BEFORE relying on this hook. The hook only fires for requests that have
   * already reached the MCP server.
   *
   * Example (allowlist):
   * ```ts
   * authorize: (toolName) => ["search", "summarize"].includes(toolName)
   * ```
   *
   * Example (block destructive tools for untrusted callers):
   * ```ts
   * authorize: (toolName, input) => myClient.role === "admin" || toolName !== "bash"
   * ```
   */
  authorize?: (toolName: string, input: unknown) => boolean | Promise<boolean>;

  /**
   * Opt-in to registering tools whose `sideEffect` is `"destructive"`.
   *
   * By default, destructive tools (e.g. `bashTool`, agent-as-tool) are **silently skipped**
   * and a `console.warn` is emitted for each one — they will NOT appear in `tools/list` and
   * cannot be called. This is a safe-by-default posture: any MCP client that connects can
   * call any registered tool, so destructive tools must be explicitly opted in.
   *
   * Set `allowDestructive: true` to register destructive tools as-is, or pass an `authorize`
   * hook (which grants equivalent explicit opt-in). Either opt-in alone is sufficient.
   *
   * ```ts
   * // Opt-in via flag (you take full responsibility for access control):
   * mcpServer({ tools, allowDestructive: true })
   *
   * // Opt-in via authorize hook (recommended — add per-call controls):
   * mcpServer({ tools, authorize: (name) => myAuth.canCall(clientId, name) })
   * ```
   */
  allowDestructive?: boolean;

  /**
   * Audit hook fired for every handled request — including denied (auth/authz-rejected) and
   * errored calls (governance posture: full audit trail, not just successful calls).
   *
   * Receives an {@link McpAuditEvent} with method, optional tool name, principal, timing, and
   * outcome. Fired synchronously in the hot path but its result is never awaited — async hooks
   * are fire-and-forget. If `onAudit` throws (sync) or rejects (async), the error is swallowed
   * and a `console.warn` is emitted once; the underlying MCP request is NOT affected.
   *
   * **Governance posture:** `onAudit` + `tracer` together provide:
   * - Per-call spans (OTel) for distributed tracing pipelines
   * - A structured audit log including denials, parse failures, and transport auth rejections
   * - `principal` field to correlate calls to the identities in your auth system
   *
   * @example
   * ```ts
   * onAudit: (event) => auditLogger.log(event)
   * ```
   */
  onAudit?: (event: McpAuditEvent) => void | Promise<void>;

  /**
   * OTel tracer for per-request spans on the server side (governance posture: distributed
   * tracing for every handled MCP request).
   *
   * When provided, each handled request emits a `mcp.handle_request` span with attributes:
   * - `mcp.method` — `"tools/list"` or `"tools/call"`
   * - `mcp.tool.name` — the requested tool name (only for `tools/call`)
   * - `mcp.duration_ms` — handler wall-clock duration in milliseconds
   * - `mcp.outcome` — `"ok"`, `"denied"`, or `"error"`
   *
   * Span status is `"error"` for denied/error outcomes, `"ok"` for success. Zero overhead when
   * not set.
   *
   * **Governance posture:** combining `tracer` with `onAudit` gives a complete picture: OTel
   * spans feed your distributed tracing backend; `onAudit` feeds your structured audit log.
   */
  tracer?: TracerPort;
}

// ---------------------------------------------------------------------------
// Internal helpers: governance (audit + tracing)
// ---------------------------------------------------------------------------

/**
 * Fire an audit event. If `onAudit` throws or rejects, swallow + warn once.
 * The caller never needs to await — this helper is fire-and-forget by design.
 */
function fireAudit(onAudit: McpServerOptions["onAudit"], event: McpAuditEvent): void {
  if (onAudit === undefined) return;
  try {
    const result = onAudit(event);
    if (result instanceof Promise) {
      result.catch((e: unknown) => {
        console.warn(
          "[eidentic/mcp] onAudit hook threw asynchronously — error suppressed to avoid breaking the request:",
          e,
        );
      });
    }
  } catch (e) {
    console.warn(
      "[eidentic/mcp] onAudit hook threw synchronously — error suppressed to avoid breaking the request:",
      e,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helper: filter tools, warn about skipped destructive ones
// ---------------------------------------------------------------------------

/**
 * Returns the subset of `tools` that should be registered on the server.
 * Destructive tools are skipped (with a console.warn) unless the caller opted in
 * via `opts.allowDestructive === true` or `opts.authorize` is set.
 */
function filterDestructiveTools(tools: Tool[], opts?: McpServerOptions): Tool[] {
  // Opt-in: explicit flag OR authorize hook present (caller has taken responsibility).
  const optedIn = opts?.allowDestructive === true || opts?.authorize !== undefined;
  if (optedIn) return tools;

  const allowed: Tool[] = [];
  for (const t of tools) {
    if (t.sideEffect === "destructive") {
      console.warn(
        `[eidentic/mcp] Skipping destructive tool '${t.id}': destructive tools are not registered by default ` +
        `because any connected MCP client can invoke any registered tool. ` +
        `To expose it, pass \`allowDestructive: true\` or an \`authorize\` hook to mcpServer/serveTools/createMcpServer.`,
      );
    } else {
      allowed.push(t);
    }
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Core: register Eidentic tools onto an McpServerLike
// ---------------------------------------------------------------------------

/**
 * §5.5 MCP server side. Register Eidentic `tools` onto `server` so any MCP
 * client can call them via `tools/list` and `tools/call`.
 *
 * **Security — read before using in production:**
 *
 * - **No authentication.** This function does NOT authenticate connecting clients. Any client
 *   that can reach the MCP transport can call any registered tool. You MUST put the HTTP
 *   transport behind your own auth middleware (e.g. bearer-token, session cookie, mTLS).
 *
 * - **No authorization by default.** All registered tools are callable by all clients unless
 *   you provide an `opts.authorize` hook. Use the hook to enforce per-call access control.
 *
 * - **Destructive tools skipped by default.** Tools with `sideEffect: "destructive"` (e.g.
 *   `bashTool`, agent-as-tool) are NOT registered unless you pass `allowDestructive: true` or
 *   an `authorize` hook. A `console.warn` is emitted for each skipped tool.
 *
 * - **Empty execution context by default.** When `opts.ctxFactory` is not set, tools receive
 *   an empty `ctx = {}` — no `PermissionPolicy`, no `SecretsPort`, no sandbox. Override
 *   `ctxFactory` to inject the security context your tools expect.
 *
 * - `tools/list` returns each tool as `{ name: tool.id, description, inputSchema }`.
 *   `inputSchema` is the tool's already-computed JSON Schema (`tool.jsonSchema`),
 *   which `createTool` derives from Zod via `z.toJSONSchema`. No re-conversion is
 *   needed — the registry's `ToolSchema.inputSchema` and `Tool.jsonSchema` are the
 *   same object.
 * - `tools/call` finds the tool, validates+executes it, and returns the result as
 *   `{ content: [{ type:"text", text: JSON.stringify(result) }] }`. On unknown tool
 *   or thrown error → `{ content: [...], isError: true }` (never throws out of the
 *   handler; error text is surfaced in the content block for debuggability).
 * - Arguments are passed verbatim as `input` to `tool.execute`; the Eidentic tool's
 *   own `parse` validates them (consistent with how ToolRegistry handles it).
 */
export function serveTools(
  server: McpServerLike,
  tools: Tool[],
  opts?: McpServerOptions,
): void {
  const registeredTools = filterDestructiveTools(tools, opts);
  const byId = new Map(registeredTools.map((t) => [t.id, t]));

  // Lazily import the request schema objects only when the real SDK is available.
  // For the structural fake used in tests, the schema argument is whatever the fake
  // expects — we pass the string method name so the fake can record it.
  // The real SDK Server.setRequestHandler expects Zod schemas (ListToolsRequestSchema,
  // CallToolRequestSchema) imported from "@modelcontextprotocol/sdk/types.js".
  // We store the schema as "any" here and let the caller (createMcpServer) supply the
  // real schema objects when wiring the real SDK server.
  // For the structural interface, we use sentinel strings so fakes can match on them.
  const LIST_SCHEMA = "tools/list" as unknown;
  const CALL_SCHEMA = "tools/call" as unknown;

  // ---------------------------------------------------------------------------
  // Transport-level authentication guard (H4)
  // Wraps a handler so that `authenticateConnection` is checked before dispatch.
  // The `connectionContext` is the raw request passed to the handler (for the
  // structural fake it is whatever the test passes; for the real SDK it is the
  // SDK request object, which callers can cast to extract headers etc.).
  // ---------------------------------------------------------------------------
  const AUTH_DENIED = {
    content: [{ type: "text", text: "connection not authenticated" }],
    isError: true,
  } as const;

  async function checkAuth(req: unknown): Promise<boolean> {
    if (opts?.authenticateConnection === undefined) return true;
    try {
      return await opts.authenticateConnection(req);
    } catch {
      return false;
    }
  }

  server.setRequestHandler(LIST_SCHEMA, async (req: unknown) => {
    const startedAt = Date.now();
    const span = opts?.tracer?.startSpan("mcp.handle_request", { "mcp.method": "tools/list" });
    if (!(await checkAuth(req))) {
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/list",
        principal: req,
        startedAt,
        durationMs,
        outcome: "denied",
        errorMessage: "connection not authenticated",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "denied");
      span?.setStatus("error", "connection not authenticated");
      span?.end();
      return AUTH_DENIED;
    }
    const result = {
      tools: registeredTools.map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: t.jsonSchema,
      })),
    };
    const durationMs = Date.now() - startedAt;
    fireAudit(opts?.onAudit, { method: "tools/list", principal: req, startedAt, durationMs, outcome: "ok" });
    span?.setAttribute("mcp.duration_ms", durationMs);
    span?.setAttribute("mcp.outcome", "ok");
    span?.setStatus("ok");
    span?.end();
    return result;
  });

  server.setRequestHandler(CALL_SCHEMA, async (req: any) => {
    const startedAt = Date.now();
    const name: string = req?.params?.name ?? req?.name;
    const args: Record<string, unknown> = req?.params?.arguments ?? req?.arguments ?? {};
    const span = opts?.tracer?.startSpan("mcp.handle_request", {
      "mcp.method": "tools/call",
      ...(name ? { "mcp.tool.name": name } : {}),
    });

    if (!(await checkAuth(req))) {
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "denied",
        errorMessage: "connection not authenticated",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "denied");
      span?.setStatus("error", "connection not authenticated");
      span?.end();
      return AUTH_DENIED;
    }

    const tool = byId.get(name);
    if (!tool) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = `unknown tool '${name}'`;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", errorMessage);
      span?.end();
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }

    // Per-call authorization check (Finding #5 High).
    if (opts?.authorize !== undefined) {
      let allowed: boolean;
      try {
        allowed = await opts.authorize(name, args);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = `tool call not authorized: '${name}'`;
        fireAudit(opts?.onAudit, {
          method: "tools/call",
          toolName: name,
          principal: req,
          startedAt,
          durationMs,
          outcome: "denied",
          errorMessage,
        });
        span?.setAttribute("mcp.duration_ms", durationMs);
        span?.setAttribute("mcp.outcome", "denied");
        span?.setStatus("error", errorMessage);
        span?.end();
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }

    // Validate via the tool's own parse (same path as ToolRegistry).
    const parsed = tool.parse(args);
    if (!parsed.ok) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = `invalid input: ${parsed.error}`;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", errorMessage);
      span?.end();
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }

    const ctx: ToolContext = opts?.ctxFactory ? opts.ctxFactory() : {};

    try {
      const result = await tool.execute(parsed.value, ctx);
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "ok",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "ok");
      span?.setStatus("ok");
      span?.end();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage: msg,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", msg);
      span?.end();
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Agent as a single MCP tool
// ---------------------------------------------------------------------------

/** Minimal agent surface `serveAgent` needs (satisfied by `@eidentic/core` `Agent`). */
export interface AgentLike {
  query(input: string, opts?: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string }): AsyncIterable<unknown> | Promise<unknown>;
}

/**
 * Expose a Eidentic `Agent` as a single MCP tool `{ name: agentId, inputSchema: {input:string} }`.
 * The MCP tool's `call` runs `agent.query(input)` and collects the final text output.
 *
 * **Security — read before using in production:**
 *
 * This function does NOT authenticate or authorize calling clients. Any MCP client that can
 * reach the transport may invoke the agent. Put the transport behind your own auth middleware.
 * For per-call control, use `serveTools` or `mcpServer` with an `authorize` hook instead.
 *
 * **Error terminals:** when the agent's final `result` event has a non-success `subtype`
 * (e.g. `"error"`, `"aborted"`, `"guardrail"`, `"max_tokens"`, `"max_turns"`, etc.), the
 * MCP response is returned as `isError: true` so the client can distinguish a partial/failed
 * run from a successful one.
 *
 * The agent must produce string output; if the last streamed event has a `text` field it is
 * used verbatim, otherwise the entire result is JSON-stringified.
 */
export function serveAgent(
  server: McpServerLike,
  agentId: string,
  agent: AgentLike,
  description = `Agent ${agentId}`,
): void {
  const LIST_SCHEMA = "tools/list" as unknown;
  const CALL_SCHEMA = "tools/call" as unknown;

  server.setRequestHandler(LIST_SCHEMA, async (_req: unknown) => {
    return {
      tools: [
        {
          name: agentId,
          description,
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string", description: "The query to send to the agent." },
              sessionId: { type: "string", description: "Optional session/context id. Defaults to a fresh UUID." },
              userId: { type: "string", description: "Optional user identity for session ownership." },
              orgId: { type: "string", description: "Optional organization identity for session ownership." },
              apiKey: { type: "string", description: "Optional API key identity for session ownership." },
            },
            required: ["input"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CALL_SCHEMA, async (req: any) => {
    const name: string = req?.params?.name ?? req?.name;
    if (name !== agentId) {
      return { content: [{ type: "text", text: `unknown tool '${name}'` }], isError: true };
    }
    const input: string = req?.params?.arguments?.input ?? req?.arguments?.input ?? "";
    const args = (req?.params?.arguments ?? req?.arguments ?? {}) as Record<string, unknown>;
    const sessionId = typeof args["sessionId"] === "string" && args["sessionId"].length > 0 ? args["sessionId"] : randomUUID();
    try {
      const result = await agent.query(input, {
        sessionId,
        ...(typeof args["userId"] === "string" ? { userId: args["userId"] } : {}),
        ...(typeof args["orgId"] === "string" ? { orgId: args["orgId"] } : {}),
        ...(typeof args["apiKey"] === "string" ? { apiKey: args["apiKey"] } : {}),
      });
      // If it's an async iterable, drain it and take the last value.
      let finalOutput: unknown = result;
      if (result != null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
        for await (const event of result as AsyncIterable<unknown>) {
          finalOutput = event;
        }
      }
      // Finding #5 Low: surface non-success agent terminals as MCP errors.
      // A terminal result event has { type: "result", subtype: TerminationSubtype }.
      // Any subtype other than "success" means the agent did NOT complete successfully.
      const isAgentError = isNonSuccessTerminal(finalOutput);

      // If the result is already a string, use it verbatim.
      // If it's an object with a `text` field (e.g. a StreamEvent), use that.
      // Otherwise, JSON-stringify.
      const text =
        typeof finalOutput === "string"
          ? finalOutput
          : finalOutput != null &&
            typeof finalOutput === "object" &&
            "text" in (finalOutput as object) &&
            typeof (finalOutput as { text: unknown }).text === "string"
          ? (finalOutput as { text: string }).text
          : JSON.stringify(finalOutput);

      return { content: [{ type: "text", text }], ...(isAgentError ? { isError: true } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  });
}

/**
 * Returns true if `event` is a terminal StreamEvent with a non-success subtype.
 * Recognises the `{ type: "result", subtype: string }` shape from `@eidentic/types` protocol.ts.
 */
function isNonSuccessTerminal(event: unknown): boolean {
  if (event == null || typeof event !== "object") return false;
  const ev = event as Record<string, unknown>;
  return ev["type"] === "result" && typeof ev["subtype"] === "string" && ev["subtype"] !== "success";
}

// ---------------------------------------------------------------------------
// Real-SDK convenience builders (dynamic import — SDK stays optional peer)
// ---------------------------------------------------------------------------

export interface McpServerHandle {
  /** The underlying McpServerLike (real SDK Server). */
  server: McpServerLike;
  /**
   * Connect via stdio (for claude_desktop / npx-style servers): reads from stdin,
   * writes to stdout. Blocks until the connection closes.
   */
  serveStdio(): Promise<void>;
  /**
   * Connect via Streamable HTTP (stateless, load-balancer-friendly). You are
   * responsible for routing POST (and optionally GET) requests to `handleRequest`.
   * Returns a minimal handle; wire `handleRequest` into your HTTP server.
   *
   * @param opts.sessionIdGenerator - Pass `() => randomUUID()` for stateful mode,
   *   or `undefined` (default) for stateless (no session tracking).
   */
  serveHttp(opts?: { sessionIdGenerator?: () => string }): {
    /** Call this for each incoming HTTP request (Node.js IncomingMessage / ServerResponse). */
    handleRequest(req: unknown, res: unknown, body?: unknown): Promise<void>;
    /** The transport instance, for cleanup. */
    transport: unknown;
  };
}

// ---------------------------------------------------------------------------
// mcpServer — opts-style primary API (§5.5 D4)
// ---------------------------------------------------------------------------

export interface McpServerToolsOpts extends McpServerOptions {
  /**
   * Eidentic tools to expose as MCP tools. Each tool's `id` becomes the MCP tool
   * name; `description` and `jsonSchema` are forwarded verbatim.
   *
   * Tools with `sideEffect: "destructive"` are **skipped by default** (with a warning).
   * Pass `allowDestructive: true` or an `authorize` hook to opt in.
   */
  tools: Tool[];
  /**
   * Optionally expose an agent as a single extra MCP tool. Requires `agentId`;
   * `agentDescription` is optional (defaults to "Agent <agentId>").
   *
   * The synthesized agent tool has `sideEffect: "destructive"`. It is subject to the
   * same destructive-opt-in requirement as any other destructive tool. Pass
   * `allowDestructive: true` or an `authorize` hook alongside `agent` to expose it.
   */
  agent?: AgentLike;
  /** Required when `agent` is provided. Becomes the MCP tool name for the agent. */
  agentId?: string;
  /** Optional description for the agent MCP tool. */
  agentDescription?: string;
}

/**
 * §5.5 D4 — primary server entry-point. Accepts an opts object with `tools` (required)
 * and optionally an `agent` to expose as a single extra MCP tool. Dynamically imports
 * the SDK `Server` (optional peer) and returns an {@link McpServerHandle} with
 * `serveStdio()` and `serveHttp()` transport helpers.
 *
 * **Security — read before deploying:**
 *
 * - **No authentication.** `mcpServer` does NOT authenticate clients. Any client that
 *   can reach the transport can call any registered tool. For HTTP transport, you MUST
 *   put it behind your own auth middleware (bearer token, session, mTLS, etc.) before
 *   exposing it to untrusted networks.
 *
 * - **No per-call authorization by default.** Provide an `authorize` hook to gate
 *   individual tool calls. Without it, all registered tools are callable by all clients.
 *
 * - **Destructive tools are skipped by default.** Tools with `sideEffect: "destructive"`
 *   (e.g. `bashTool`, agent-as-tool) will NOT be registered unless you explicitly opt in
 *   via `allowDestructive: true` or an `authorize` hook. A warning is emitted for each
 *   skipped tool. Do NOT expose destructive tools to untrusted clients.
 *
 * - **Empty execution context by default.** When `ctxFactory` is not provided, tools run
 *   with `ctx = {}` — no `PermissionPolicy`, no `SecretsPort`, no sandbox. Override
 *   `ctxFactory` to inject the security context your tools require.
 *
 * Usage (stdio — for claude_desktop / npx-style):
 * ```ts
 * const handle = await mcpServer({ tools, name: "my-server", version: "1.0.0" });
 * await handle.serveStdio(); // blocks
 * ```
 *
 * Usage (HTTP — put behind auth middleware!):
 * ```ts
 * import { createServer } from "node:http";
 * const handle = await mcpServer({ tools });
 * const { handleRequest } = handle.serveHttp({ sessionIdGenerator: () => randomUUID() });
 * createServer((req, res) => handleRequest(req, res)).listen(3000);
 * ```
 *
 * Usage (tools + agent, with explicit opt-in):
 * ```ts
 * const handle = await mcpServer({
 *   tools,
 *   agent,
 *   agentId: "my-agent",
 *   allowDestructive: true, // or pass authorize hook
 * });
 * await handle.serveStdio();
 * ```
 */
export async function mcpServer(opts: McpServerToolsOpts): Promise<McpServerHandle> {
  const { tools, agent, agentId, agentDescription, ...serverOpts } = opts;

  // Build the combined tool list: Eidentic tools + optional agent pseudo-tool.
  const allTools: Tool[] = [...tools];
  if (agent !== undefined) {
    if (!agentId) {
      throw new Error("mcpServer: `agentId` is required when `agent` is provided");
    }
    // Synthesize a Eidentic Tool that delegates to the agent.
    // sideEffect is "destructive" — it will be filtered out unless the caller opts in.
    const aid = agentId;
    const adesc = agentDescription ?? `Agent ${aid}`;
    allTools.push({
      id: aid,
      description: adesc,
      sideEffect: "destructive",
      jsonSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "The query to send to the agent." },
          sessionId: { type: "string", description: "Optional session/context id. Defaults to a fresh UUID." },
          userId: { type: "string", description: "Optional user identity for session ownership." },
          orgId: { type: "string", description: "Optional organization identity for session ownership." },
          apiKey: { type: "string", description: "Optional API key identity for session ownership." },
        },
        required: ["input"],
      },
      parse: (raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } => {
        const obj = raw as Record<string, unknown>;
        if (typeof obj?.input !== "string") {
          return { ok: false as const, error: "`input` must be a string" };
        }
        return { ok: true as const, value: obj };
      },
      execute: async (input: unknown): Promise<unknown> => {
        const queryInput = (input as { input: string }).input;
        const obj = input as { sessionId?: unknown; userId?: unknown; orgId?: unknown; apiKey?: unknown };
        const result = await agent.query(queryInput, {
          sessionId: typeof obj.sessionId === "string" && obj.sessionId.length > 0 ? obj.sessionId : randomUUID(),
          ...(typeof obj.userId === "string" ? { userId: obj.userId } : {}),
          ...(typeof obj.orgId === "string" ? { orgId: obj.orgId } : {}),
          ...(typeof obj.apiKey === "string" ? { apiKey: obj.apiKey } : {}),
        });
        let finalOutput: unknown = result;
        if (result != null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
          for await (const event of result as AsyncIterable<unknown>) {
            finalOutput = event;
          }
        }
        // Finding #5 Low: propagate non-success agent terminal as an error throw
        // so the MCP layer surfaces it as isError:true.
        if (isNonSuccessTerminal(finalOutput)) {
          const ev = finalOutput as Record<string, unknown>;
          const subtype = ev["subtype"] as string;
          throw new Error(`agent terminated with subtype '${subtype}'`);
        }
        return typeof finalOutput === "string"
          ? finalOutput
          : finalOutput != null &&
            typeof finalOutput === "object" &&
            "text" in (finalOutput as object) &&
            typeof (finalOutput as { text: unknown }).text === "string"
          ? (finalOutput as { text: string }).text
          : JSON.stringify(finalOutput);
      },
    });
  }

  return createMcpServer(allTools, serverOpts);
}

// ---------------------------------------------------------------------------
// createMcpServer — positional-args builder (kept for back-compat)
// ---------------------------------------------------------------------------

/**
 * Dynamically import the MCP SDK `Server`, register `tools` via `serveTools`, and
 * return a handle with transport helpers. Throws an actionable error if the SDK peer
 * dependency is missing (mirrors `streamableHttpClient`).
 *
 * **Security — read before deploying:**
 *
 * - **No authentication.** Any MCP client that reaches the transport can call all registered
 *   tools. Put the HTTP transport behind your own auth middleware.
 * - **No per-call authorization by default.** Pass `opts.authorize` to gate individual calls.
 * - **Destructive tools are skipped by default** (with a warning). Pass `opts.allowDestructive`
 *   or `opts.authorize` to opt in. Do NOT expose destructive tools to untrusted clients.
 * - **Empty execution context by default.** Override `opts.ctxFactory` to inject
 *   `PermissionPolicy`, `SecretsPort`, or a sandbox into every tool invocation.
 *
 * Prefer {@link mcpServer} for new code — it accepts an opts object and supports
 * exposing an agent alongside tools.
 *
 * Usage (stdio — for claude_desktop / npx-style):
 * ```ts
 * const { serveStdio } = await createMcpServer(tools, { name: "my-server", version: "1.0.0" });
 * await serveStdio(); // blocks
 * ```
 *
 * Usage (HTTP — put behind auth middleware!):
 * ```ts
 * import { createServer } from "node:http";
 * const { serveHttp } = await createMcpServer(tools);
 * const { handleRequest } = serveHttp({ sessionIdGenerator: () => randomUUID() });
 * createServer((req, res) => handleRequest(req, res)).listen(3000);
 * ```
 */
export async function createMcpServer(
  tools: Tool[],
  opts?: McpServerOptions,
): Promise<McpServerHandle> {
  let Server: any;
  let ListToolsRequestSchema: any;
  let CallToolRequestSchema: any;
  let StdioServerTransport: any;
  let StreamableHTTPServerTransport: any;

  try {
    ({ Server } = await import("@modelcontextprotocol/sdk/server/index.js"));
    ({ ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js"));
    ({ StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js"));
    ({ StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js"));
  } catch {
    throw new Error(
      "@eidentic/mcp server helpers require the optional peer dependency '@modelcontextprotocol/sdk'. " +
      "Install it (pnpm add @modelcontextprotocol/sdk), or inject your own McpServerLike into serveTools().",
    );
  }

  const name = opts?.name ?? "eidentic";
  const version = opts?.version ?? "0.0.0";

  const server: any = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  // Apply the destructive-tool filter here too (createMcpServer is the real-SDK path).
  const registeredTools = filterDestructiveTools(tools, opts);
  const byId = new Map(registeredTools.map((t) => [t.id, t]));

  // ---------------------------------------------------------------------------
  // Transport-level authentication guard (H4) — same logic as in serveTools.
  // ---------------------------------------------------------------------------
  const AUTH_DENIED_SDK = {
    content: [{ type: "text", text: "connection not authenticated" }],
    isError: true,
  } as const;

  async function checkAuthSdk(req: unknown): Promise<boolean> {
    if (opts?.authenticateConnection === undefined) return true;
    try {
      return await opts.authenticateConnection(req);
    } catch {
      return false;
    }
  }

  // Register with REAL schema objects so the SDK validates request shapes.
  server.setRequestHandler(ListToolsRequestSchema, async (req: unknown) => {
    const startedAt = Date.now();
    const span = opts?.tracer?.startSpan("mcp.handle_request", { "mcp.method": "tools/list" });
    if (!(await checkAuthSdk(req))) {
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/list",
        principal: req,
        startedAt,
        durationMs,
        outcome: "denied",
        errorMessage: "connection not authenticated",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "denied");
      span?.setStatus("error", "connection not authenticated");
      span?.end();
      return AUTH_DENIED_SDK;
    }
    const result = {
      tools: registeredTools.map((t) => ({
        name: t.id,
        description: t.description,
        inputSchema: t.jsonSchema,
      })),
    };
    const durationMs = Date.now() - startedAt;
    fireAudit(opts?.onAudit, { method: "tools/list", principal: req, startedAt, durationMs, outcome: "ok" });
    span?.setAttribute("mcp.duration_ms", durationMs);
    span?.setAttribute("mcp.outcome", "ok");
    span?.setStatus("ok");
    span?.end();
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const startedAt = Date.now();
    const name: string = req?.params?.name;
    const args: Record<string, unknown> = req?.params?.arguments ?? {};
    const span = opts?.tracer?.startSpan("mcp.handle_request", {
      "mcp.method": "tools/call",
      ...(name ? { "mcp.tool.name": name } : {}),
    });

    if (!(await checkAuthSdk(req))) {
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "denied",
        errorMessage: "connection not authenticated",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "denied");
      span?.setStatus("error", "connection not authenticated");
      span?.end();
      return AUTH_DENIED_SDK;
    }

    const tool = byId.get(name);
    if (!tool) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = `unknown tool '${name}'`;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", errorMessage);
      span?.end();
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }

    // Per-call authorization check.
    if (opts?.authorize !== undefined) {
      let allowed: boolean;
      try {
        allowed = await opts.authorize(name, args);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = `tool call not authorized: '${name}'`;
        fireAudit(opts?.onAudit, {
          method: "tools/call",
          toolName: name,
          principal: req,
          startedAt,
          durationMs,
          outcome: "denied",
          errorMessage,
        });
        span?.setAttribute("mcp.duration_ms", durationMs);
        span?.setAttribute("mcp.outcome", "denied");
        span?.setStatus("error", errorMessage);
        span?.end();
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
        };
      }
    }

    const parsed = tool.parse(args);
    if (!parsed.ok) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = `invalid input: ${parsed.error}`;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", errorMessage);
      span?.end();
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }

    const ctx: ToolContext = opts?.ctxFactory ? opts.ctxFactory() : {};

    try {
      const result = await tool.execute(parsed.value, ctx);
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "ok",
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "ok");
      span?.setStatus("ok");
      span?.end();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const durationMs = Date.now() - startedAt;
      fireAudit(opts?.onAudit, {
        method: "tools/call",
        toolName: name,
        principal: req,
        startedAt,
        durationMs,
        outcome: "error",
        errorMessage: msg,
      });
      span?.setAttribute("mcp.duration_ms", durationMs);
      span?.setAttribute("mcp.outcome", "error");
      span?.setStatus("error", msg);
      span?.end();
      return {
        content: [{ type: "text", text: msg }],
        isError: true,
      };
    }
  });

  return {
    server: server as McpServerLike,

    async serveStdio(): Promise<void> {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },

    serveHttp(httpOpts?: { sessionIdGenerator?: () => string }) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: httpOpts?.sessionIdGenerator,
      });
      return {
        handleRequest: (req: unknown, res: unknown, body?: unknown) =>
          transport.handleRequest(req, res, body),
        transport,
      };
    },
  };
}
