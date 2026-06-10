import type { SideEffect, Tool } from "@eidentic/core";
import type { TracerPort } from "@eidentic/types";

export type {
  McpServerLike,
  McpServerOptions,
  McpServerHandle,
  McpServerToolsOpts,
  AgentLike,
  McpAuditEvent,
} from "./server.js";
export { serveTools, serveAgent, createMcpServer, mcpServer } from "./server.js";

// OAuth 2.1 + PKCE client auth
export type {
  OAuthServerConfig,
  OAuthTokens,
  OAuthTokenStore,
  AuthorizationFlowParams,
} from "./oauth.js";
export {
  generateCodeVerifier,
  deriveCodeChallenge,
  base64urlEncode,
  generateState,
  beginAuthorizationFlow,
  completeAuthorizationFlow,
  refreshAccessToken,
  OAuthConnection,
  OAuthStateError,
  OAuthTokenError,
} from "./oauth.js";

/**
 * Minimal structural subset of `@modelcontextprotocol/sdk`'s `Client` that `mcpTools` uses.
 * Confirmed against sdk@1.29.0 (Spike). Production passes a real connected `Client` (via the
 * transport helpers below); tests pass an in-memory fake of this shape. `mcpTools` stays
 * SDK-free — it only ever sees this interface.
 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** Already JSON Schema (object schema). Passed through verbatim as the Eidentic `jsonSchema`. */
  inputSchema: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult>;
}

export interface McpToolsOptions {
  /** When set, tool ids become `${prefix}__${name}` (double-underscore, MCP-namespacing convention). Default: no prefix. */
  prefix?: string;
  /**
   * sideEffect for UNANNOTATED remote tools. Default `"destructive"` (§5.5 safe default).
   * Never overrides a server's readOnlyHint — use `forceSideEffect` if you need to override that.
   */
  defaultSideEffect?: SideEffect;
  /**
   * When set, ALL wrapped tools receive this sideEffect regardless of the server's self-declared
   * `readOnlyHint`. Use when you cannot trust the server's annotations (e.g. an untrusted server
   * claiming read-only to bypass the human gate). NOTE: a server's `readOnlyHint:true` otherwise
   * grants the read-only concurrent + ledger-exempt fast path — only override when truly needed.
   */
  forceSideEffect?: SideEffect;
  /**
   * OTel tracer for per-call observability (governance posture: per-call spans on the host side).
   *
   * When provided, each wrapped MCP tool call emits a `mcp.call_tool` span with attributes:
   * - `mcp.tool.name` — the remote tool name (without prefix)
   * - `mcp.server.id` — the server identifier (value of `opts.prefix` when set, otherwise absent)
   * - `mcp.duration_ms` — wall-clock duration of the `callTool` round-trip in milliseconds
   * - `error` — `true` when the MCP response has `isError:true` or the call throws
   *
   * Span status is set to `"error"` on failure, `"ok"` on success. Zero overhead when not set.
   *
   * **Governance posture:** combining host-side spans with server-side `onAudit` + `tracer` gives
   * a complete audit trail: every call is tracked end-to-end including denials and parse failures.
   */
  tracer?: TracerPort;
}

/** Join an MCP tool result's content into a single string. Text blocks concatenated; non-text summarized. */
function joinContent(content: McpContentBlock[]): string {
  return content
    .map((b) => {
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      if (b.type === "audio") return "[audio]";
      if (b.type === "resource") return "[resource]";
      return `[${b.type}]`;
    })
    .join("");
}

/**
 * §5.5 MCP host. Connect-agnostic: takes an already-connected `McpClientLike`, lists its tools,
 * and wraps each as a first-class Eidentic `Tool` so `ToolRegistry`/the agent loop dispatch them
 * unchanged. Annotation invariant: `readOnlyHint:true` → `"read-only"` (parallelizable);
 * unannotated → `opts.defaultSideEffect ?? "destructive"` (safe — deny-by-default + human-gate).
 *
 * MCP tools carry a JSON Schema directly, so we build `Tool` objects by hand (NOT `createTool`,
 * which derives the schema from Zod): `jsonSchema` is the MCP `inputSchema` passed through; `parse`
 * is a pass-through (the server validates args); `execute` calls `callTool` and maps the result —
 * an MCP `isError:true` is re-thrown so `ToolRegistry` marks the result `isError:true`.
 */
export async function mcpTools(client: McpClientLike, opts: McpToolsOptions = {}): Promise<Tool[]> {
  const { prefix, defaultSideEffect = "destructive", forceSideEffect, tracer } = opts;
  const { tools } = await client.listTools();

  // Guard: duplicate tool id after prefixing → last-wins silently in ToolRegistry; throw early.
  const seenIds = new Set<string>();
  for (const t of tools) {
    const id = prefix ? `${prefix}__${t.name}` : t.name;
    if (seenIds.has(id)) {
      throw new Error(
        `mcpTools: duplicate tool id '${id}' after prefixing — the MCP server returned two tools that resolve to the same id`,
      );
    }
    seenIds.add(id);
  }

  return tools.map((t): Tool => {
    const id = prefix ? `${prefix}__${t.name}` : t.name;
    // forceSideEffect overrides everything; otherwise readOnlyHint:true → "read-only"; else default.
    const sideEffect: SideEffect =
      forceSideEffect !== undefined
        ? forceSideEffect
        : t.annotations?.readOnlyHint === true
          ? "read-only"
          : defaultSideEffect;
    return {
      id,
      description: t.description ?? `MCP tool ${t.name}`,
      sideEffect,
      jsonSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      // Pass-through: the MCP server validates arguments server-side. We accept any object.
      parse: (input) => ({ ok: true, value: input }),
      execute: async (input) => {
        // Governance: emit a span for every MCP tool call when a tracer is configured.
        const spanAttrs: Record<string, string | number | boolean> = {
          "mcp.tool.name": t.name,
        };
        if (prefix !== undefined) spanAttrs["mcp.server.id"] = prefix;
        const span = tracer?.startSpan("mcp.call_tool", spanAttrs);
        const t0 = span !== undefined ? Date.now() : 0;
        try {
          const result = await client.callTool({
            name: t.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          });
          if (result.isError) {
            // Throw so ToolRegistry.execOne catches it into { isError: true, output: { error } } —
            // consistent with how every other Eidentic tool surfaces failure (§5.5 per-tool diagnostics).
            const errText = joinContent(result.content ?? []);
            if (span !== undefined) {
              span.setAttribute("mcp.duration_ms", Date.now() - t0);
              span.setAttribute("error", true);
              span.setStatus("error", errText || `MCP tool '${t.name}' returned isError`);
              span.end();
            }
            throw new Error(errText || `MCP tool '${t.name}' returned isError`);
          }
          // Prefer structuredContent when present and the joined text content is empty (a tool may
          // return ONLY structured data with no text blocks). When both are present, return the text
          // (callers that need structured data can inspect result.structuredContent directly); if text
          // is empty, fall back to the JSON-serialized structuredContent so the model sees the data.
          const text = joinContent(result.content ?? []);
          if (span !== undefined) {
            span.setAttribute("mcp.duration_ms", Date.now() - t0);
            span.setStatus("ok");
            span.end();
          }
          if (text === "" && result.structuredContent !== undefined) {
            return JSON.stringify(result.structuredContent);
          }
          return text;
        } catch (e) {
          // Re-throw after closing the span (handles unexpected transport errors).
          if (span !== undefined) {
            span.setAttribute("mcp.duration_ms", Date.now() - t0);
            span.setAttribute("error", true);
            span.setStatus("error", e instanceof Error ? e.message : String(e));
            span.end();
          }
          throw e;
        }
      },
    };
  });
}

/** Options for {@link streamableHttpClient}. */
export interface StreamableHttpClientOptions {
  /**
   * Extra static HTTP headers, e.g. `{ Authorization: "Bearer …" }`.
   * Mapped to the SDK transport's `requestInit.headers`.
   * For dynamic OAuth 2.1 bearer tokens, prefer `opts.oauth` which handles
   * automatic refresh; `headers` is for static tokens or other custom headers.
   */
  headers?: Record<string, string>;
  /**
   * OAuth 2.1 connection that manages bearer token injection and automatic refresh.
   * When provided, `getAuthorizationHeader()` is called before each connection and
   * the returned `Authorization` header is merged with any static `opts.headers`.
   *
   * Obtain an `OAuthConnection` by completing the authorization flow:
   * ```ts
   * const conn = new OAuthConnection(config);
   * const { authorizationUrl, state, codeVerifier } = await beginAuthorizationFlow(config);
   * // redirect user → they come back with ?code=…&state=…
   * const tokens = await completeAuthorizationFlow(config, code, codeVerifier, returnedState, state);
   * await conn.setTokens(tokens);
   * const client = await streamableHttpClient(url, { oauth: conn });
   * ```
   */
  oauth?: import("./oauth.js").OAuthConnection;
  /** Client identity advertised to the server. Defaults to `{ name: "eidentic", version: "0.0.0" }`. */
  clientInfo?: { name: string; version: string };
}

/** Options for {@link stdioClient}. */
export interface StdioClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  clientInfo?: { name: string; version: string };
}

const DEFAULT_CLIENT_INFO = { name: "eidentic", version: "0.0.0" };

/**
 * Connect to a remote MCP server over Streamable HTTP (the §5.5 default transport: stateless,
 * load-balancer-friendly) and return a connected client as `McpClientLike`.
 *
 * **Auth options (choose one):**
 *
 * - `opts.headers` — static headers, e.g. `{ Authorization: "Bearer <token>" }`.
 * - `opts.oauth` — an {@link OAuthConnection} that manages dynamic bearer tokens with
 *   automatic refresh. When provided, `getAuthorizationHeader()` is called and the
 *   result is merged with `opts.headers` (OAuth wins on `Authorization` if both set).
 *
 * **OAuth example:**
 * ```ts
 * const config: OAuthServerConfig = {
 *   authorizationEndpoint: "https://auth.example.com/oauth/authorize",
 *   tokenEndpoint: "https://auth.example.com/oauth/token",
 *   clientId: "my-client-id",
 *   redirectUri: "http://localhost:3000/callback",
 *   scope: "mcp:read mcp:write",
 * };
 * const conn = new OAuthConnection(config);
 * // Complete the flow first (redirect user, receive code, exchange):
 * const { authorizationUrl, state, codeVerifier } = await beginAuthorizationFlow(config);
 * // ... user visits authorizationUrl and is redirected back with ?code=…&state=…
 * const tokens = await completeAuthorizationFlow(config, code, codeVerifier, returnedState, state);
 * await conn.setTokens(tokens);
 * // Now connect — bearer token injected automatically, refreshed as needed:
 * const client = await streamableHttpClient("https://mcp.example.com/mcp", { oauth: conn });
 * const tools = await mcpTools(client);
 * ```
 */
export async function streamableHttpClient(
  url: string | URL,
  opts: StreamableHttpClientOptions = {},
): Promise<McpClientLike> {
  let Client: any, StreamableHTTPClientTransport: any;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
  } catch {
    throw new Error(
      "@eidentic/mcp transport helpers require the optional peer dependency '@modelcontextprotocol/sdk'. " +
      "Install it (pnpm add @modelcontextprotocol/sdk), or inject your own McpClientLike into mcpTools().",
    );
  }

  // Build the combined headers object: static headers + optional OAuth bearer token.
  let headers: Record<string, string> | undefined = opts.headers
    ? { ...opts.headers }
    : undefined;

  if (opts.oauth) {
    const authHeader = await opts.oauth.getAuthorizationHeader();
    headers = { ...(headers ?? {}), Authorization: authHeader };
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    headers ? { requestInit: { headers } } : {},
  );
  const client = new Client(opts.clientInfo ?? DEFAULT_CLIENT_INFO);
  await client.connect(transport);
  return client as unknown as McpClientLike;
}

/**
 * Connect to a local MCP server over stdio (§5.5 local-dev transport) by spawning `command args`
 * and return a connected client as `McpClientLike`.
 */
export async function stdioClient(opts: StdioClientOptions): Promise<McpClientLike> {
  let Client: any, StdioClientTransport: any;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js"));
  } catch {
    throw new Error(
      "@eidentic/mcp transport helpers require the optional peer dependency '@modelcontextprotocol/sdk'. " +
      "Install it (pnpm add @modelcontextprotocol/sdk), or inject your own McpClientLike into mcpTools().",
    );
  }
  const transport = new StdioClientTransport({
    command: opts.command,
    ...(opts.args ? { args: opts.args } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const client = new Client(opts.clientInfo ?? DEFAULT_CLIENT_INFO);
  await client.connect(transport);
  return client as unknown as McpClientLike;
}
