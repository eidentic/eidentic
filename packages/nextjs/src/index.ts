/**
 * @eidentic/nextjs — Next.js App Router integration for Eidentic agents.
 *
 * ## Quick start
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { withEidentic } from "@eidentic/nextjs";
 * import { myAgent } from "@/lib/agent";
 *
 * export const runtime = "nodejs"; // Required: Eidentic uses Node.js APIs
 * export const POST = withEidentic(myAgent);
 * ```
 *
 * ## next.config setup
 *
 * Avoid native-module bundling errors with `eidenticNextConfig`:
 *
 * ```ts
 * // next.config.ts
 * import { eidenticNextConfig } from "@eidentic/nextjs";
 * import type { NextConfig } from "next";
 *
 * const nextConfig: NextConfig = {};
 * export default eidenticNextConfig(nextConfig);
 * ```
 *
 * If you use `@eidentic/sqlite` (which depends on `better-sqlite3`, a native
 * addon), the config helper ensures it is not bundled by the Next.js Webpack
 * pipeline.  Prefer `@eidentic/libsql` in serverless/edge environments since
 * it has no native addon.
 */

import type { Agent } from "@eidentic/core";
import {
  toUIMessageStreamResponse,
  type ToUIMessageStreamOptions,
} from "@eidentic/server";

// ---------------------------------------------------------------------------
// Protocol type
// ---------------------------------------------------------------------------

/**
 * Wire protocol for the route handler response.
 *
 * - `"ai-sdk-ui"` (default) — AI SDK v7 UI message-stream format.
 *   Compatible with `useChat` from `@ai-sdk/react`.  This is the recommended
 *   default: structured, typed, and compatible with the entire AI SDK
 *   ecosystem.
 *
 * - `"ndjson"` — Raw NDJSON stream of `StreamEvent` objects, one per line.
 *   Use this with `@eidentic/react`'s `useEidenticStream`.  Choose this when you
 *   need access to low-level Eidentic events (tool results, session metadata,
 *   cost/usage) that the AI SDK UI protocol does not surface.
 */
export type EidenticProtocol = "ai-sdk-ui" | "ndjson";

// ---------------------------------------------------------------------------
// withEidentic options
// ---------------------------------------------------------------------------

export interface WithEidenticOptions {
  /**
   * Stream protocol.  Defaults to `"ai-sdk-ui"`.
   *
   * Use `"ai-sdk-ui"` when the frontend uses `useChat` (AI SDK / CopilotKit).
   * Use `"ndjson"` when the frontend uses `@eidentic/react`'s `useEidenticStream`
   * or when you need raw `StreamEvent` access.
   *
   * @default "ai-sdk-ui"
   */
  protocol?: EidenticProtocol;

  /**
   * Extra HTTP headers to include in the streaming response.
   * Forwarded to `toUIMessageStreamResponse` (for `"ai-sdk-ui"` protocol) or
   * set on the raw `Response` (for `"ndjson"` protocol).
   */
  headers?: Headers | Record<string, string>;

  /**
   * Maximum allowed request body size in bytes. Requests with a `Content-Length`
   * header exceeding this limit are rejected with HTTP 413 before the body is
   * parsed. Defaults to 1 MB (1_048_576 bytes).
   *
   * @default 1_048_576
   */
  maxBodyBytes?: number;

  /**
   * Derive the trusted principal identity server-side from the incoming request.
   * When provided, the returned `userId`, `orgId`, and `apiKey` are used instead of any
   * values supplied in the request body, preventing clients from spoofing their
   * identity.
   *
   * IMPORTANT: This is the recommended way to set `userId` in multi-tenant
   * deployments. Always derive identity from your application's authenticated
   * session (e.g. via cookies, JWT, or a session store), NOT from the request
   * body, which is caller-controlled.
   *
   * @example
   * ```ts
   * export const POST = withEidentic(agent, {
   *   async identify(req) {
   *     const session = await getServerSession(req); // your auth helper
   *     return { userId: session.user.id };
   *   },
   * });
   * ```
   */
  identify?: (req: Request) => { userId?: string; orgId?: string; apiKey?: string } | Promise<{ userId?: string; orgId?: string; apiKey?: string }>;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface EidenticRequestBody {
  /** The user message as a plain string. */
  input?: string;
  /** Alias for `input`. */
  message?: string;
  /**
   * A Vercel AI SDK `useChat` message history (`{ messages: [...] }` is what `useChat` POSTs by
   * default). The newest user message's text is used as the input; the agent reloads prior turns
   * from the store via `sessionId`, so the full history isn't replayed. Both the v5+ `parts` shape
   * and the legacy `content` string are accepted.
   */
  messages?: Array<{ role?: string; content?: string; parts?: Array<{ type?: string; text?: string }> }>;
  /** Optional session identifier.  A new UUID is minted when absent. */
  sessionId?: string;
  /**
   * Optional user identifier forwarded to the agent for memory scoping.
   *
   * WARNING: This value comes from the client and MUST NOT be trusted for
   * access control. Use the `identify` option to derive the userId server-side
   * from your authenticated session instead.
   */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toHeaders(h: Headers | Record<string, string>): Headers {
  if (h instanceof Headers) return h;
  return new Headers(h);
}

/**
 * Extract the newest user message's text from a `useChat`-style `{ messages: [...] }` body.
 *
 * `useChat` POSTs the full UIMessage history with the just-typed user message last; the agent
 * reloads prior turns from the store via `sessionId`, so only that newest user message is the input.
 * Reads both the AI SDK v5+ `parts` array (`{ type: "text", text }`) and the legacy `content` string.
 */
function lastUserMessageText(messages: EidenticRequestBody["messages"]): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || (m.role !== undefined && m.role !== "user")) continue;
    if (typeof m.content === "string" && m.content.trim() !== "") return m.content;
    if (Array.isArray(m.parts)) {
      const text = m.parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (text.trim() !== "") return text;
    }
    return undefined; // newest user message had no extractable text — don't fall back to older turns
  }
  return undefined;
}

/** Default body size cap: 1 MB. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// withEidentic — Next.js App Router POST handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a Next.js App Router POST route handler that streams a Eidentic
 * agent's response to the client.
 *
 * **SECURITY NOTICE — this function performs NO authentication or authorization.**
 * It is a low-level convenience wrapper that reads the request body and starts
 * an agent run. In any multi-tenant deployment you MUST:
 *
 * 1. Authenticate the caller BEFORE the handler runs (e.g. via Next.js middleware,
 *    or an `identify` option that reads your session cookie / JWT).
 * 2. Derive `userId` and `sessionId` from your application's authenticated session,
 *    NOT from the request body (`body.userId` / `body.sessionId` are caller-controlled
 *    and can be forged). Use the `identify` option for this.
 * 3. Never expose this handler on a public route without protecting it.
 *
 * @example
 * ```ts
 * // app/api/chat/route.ts
 * import { withEidentic } from "@eidentic/nextjs";
 * import { myAgent } from "@/lib/agent";
 *
 * // IMPORTANT: Eidentic requires the Node.js runtime (SQLite, crypto, etc.).
 * // Add this export to every route file that uses withEidentic.
 * export const runtime = "nodejs";
 *
 * // Simple (single-tenant / no auth):
 * export const POST = withEidentic(myAgent);
 *
 * // Multi-tenant — derive userId server-side from the authenticated session:
 * export const POST = withEidentic(myAgent, {
 *   async identify(req) {
 *     const session = await getServerSession(req); // your auth helper
 *     if (!session) throw new Error("Unauthenticated"); // or return 401 yourself
 *     return { userId: session.user.id };
 *   },
 * });
 * // or with options:
 * // export const POST = withEidentic(myAgent, { protocol: "ndjson" });
 * ```
 *
 * ### Request body (JSON)
 *
 * | Field       | Type           | Required | Description                                          |
 * |-------------|----------------|----------|------------------------------------------------------|
 * | `input`     | `string`       | yes*     | The user message                                     |
 * | `message`   | `string`       | yes*     | Alias for `input`                                    |
 * | `messages`  | `UIMessage[]`  | yes*     | A `useChat` history — the newest user message is used |
 * | `sessionId` | `string`       | no       | Resume an existing session                           |
 * | `userId`    | `string`       | no       | User ID for memory scoping (see WARNING)             |
 *
 * *One of `input`, `message`, or a non-empty `messages` array must be present. The `messages`
 * form is what Vercel's `useChat` POSTs by default, so the route works with `useChat` out of the
 * box — no client-side request transform (e.g. `prepareSendMessagesRequest`) is needed. The agent
 * reloads prior turns from the store via `sessionId`, so only the newest user message is read.
 *
 * WARNING: `userId` and `sessionId` in the request body are caller-controlled.
 * Always derive identity server-side via the `identify` option in multi-tenant
 * deployments — do not rely on client-supplied values for access control.
 *
 * ### Protocol: `"ai-sdk-ui"` (default)
 *
 * The response uses the Vercel AI SDK v7 UI message-stream SSE format.
 * Wire it up with `useChat` from `@ai-sdk/react`:
 *
 * ```tsx
 * import { useChat } from "@ai-sdk/react";
 * const { messages, input, handleInputChange, handleSubmit } = useChat({
 *   api: "/api/chat",
 * });
 * ```
 *
 * ### Protocol: `"ndjson"`
 *
 * Each line is a JSON-serialised `StreamEvent` followed by `\n`.
 * Content-Type is `application/x-ndjson`.
 * Use `@eidentic/react`'s `useEidenticStream` on the client.
 */
export function withEidentic(
  agent: Agent,
  opts: WithEidenticOptions = {},
): (req: Request) => Promise<Response> {
  const protocol: EidenticProtocol = opts.protocol ?? "ai-sdk-ui";
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function handler(req: Request): Promise<Response> {
    // Body-size guard (Fix #8a) — enforce limit on actual bytes, not just the
    // Content-Length header, so chunked transfer-encoding cannot bypass it.
    //
    // Fast-path: if Content-Length is present and already exceeds the cap, reject
    // immediately without reading the body at all.
    const contentLength = req.headers.get("content-length");
    if (contentLength !== null) {
      const bytes = parseInt(contentLength, 10);
      if (!isNaN(bytes) && bytes > maxBodyBytes) {
        return new Response(
          JSON.stringify({ error: `Request body too large (max ${maxBodyBytes} bytes)` }),
          { status: 413, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // Streaming byte-count enforcement — covers chunked and any other transfer
    // where Content-Length is absent or untrustworthy. We read the raw bytes
    // through the request's ReadableStream, counting as we go, and abort with
    // 413 the moment the cap is exceeded (without buffering the rest).
    let rawText: string;
    try {
      const reader = req.body?.getReader();
      if (!reader) {
        // No body at all — treat as empty; JSON.parse will fail and return 400.
        rawText = "";
      } else {
        const decoder = new TextDecoder();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > maxBodyBytes) {
              reader.cancel().catch(() => {/* ignore */});
              return new Response(
                JSON.stringify({ error: `Request body too large (max ${maxBodyBytes} bytes)` }),
                { status: 413, headers: { "Content-Type": "application/json" } },
              );
            }
            chunks.push(value);
          }
        }
        rawText = decoder.decode(
          chunks.length === 1
            ? chunks[0]
            : chunks.reduce((acc, c) => {
                const merged = new Uint8Array(acc.byteLength + c.byteLength);
                merged.set(acc, 0);
                merged.set(c, acc.byteLength);
                return merged;
              }, new Uint8Array(0)),
        );
      }
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Parse body
    let body: EidenticRequestBody;
    try {
      body = JSON.parse(rawText) as EidenticRequestBody;
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Resolve input — accept a plain `input`/`message` string, or a `useChat` `messages` array
    // (newest user message). This makes the route work out of the box with Vercel's `useChat`,
    // which POSTs `{ messages: [...] }` by default — no client-side request bridge needed.
    const input = body.input ?? body.message ?? lastUserMessageText(body.messages);
    if (typeof input !== "string" || input.trim() === "") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid input — provide 'input', 'message', or a 'messages' array" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.length > 0
        ? body.sessionId
        : crypto.randomUUID();

    // Fix #8b — derive identity server-side via `identify` when provided.
    // The server-side identity OVERRIDES any body-supplied userId/orgId so that
    // the client cannot spoof their identity.
    let userId: string | undefined;
    let orgId: string | undefined;
    let apiKey: string | undefined;
    if (opts.identify) {
      const principal = await opts.identify(req);
      userId = principal.userId;
      orgId = principal.orgId;
      apiKey = principal.apiKey;
    } else {
      // Fall back to body-supplied userId (single-tenant / no auth path).
      // WARNING: body.userId is caller-controlled; use `identify` in multi-tenant deployments.
      userId =
        typeof body.userId === "string" && body.userId.length > 0
          ? body.userId
          : undefined;
    }

    const signal = req.signal;

    const events = agent.query(input, { sessionId, userId, orgId, apiKey, signal });

    if (protocol === "ai-sdk-ui") {
      const streamOpts: ToUIMessageStreamOptions = {};
      if (opts.headers) {
        streamOpts.headers = toHeaders(opts.headers);
      }
      return toUIMessageStreamResponse(events, streamOpts);
    }

    // "ndjson" protocol — raw StreamEvent stream, one JSON line per event
    const extraHeaders = opts.headers ? toHeaders(opts.headers) : new Headers();
    extraHeaders.set("Content-Type", "application/x-ndjson");
    extraHeaders.set("Transfer-Encoding", "chunked");

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for await (const ev of events) {
            if (signal.aborted) break;
            controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
          }
        } catch (err: unknown) {
          if (!signal.aborted) {
            const msg = err instanceof Error ? err.message : String(err);
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "result",
                  subtype: "error",
                  output: msg,
                  usage: { inputTokens: 0, outputTokens: 0 },
                  numTurns: 0,
                  sessionId,
                }) + "\n",
              ),
            );
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: extraHeaders });
  };
}

// ---------------------------------------------------------------------------
// eidenticNextConfig — next.config helper
// ---------------------------------------------------------------------------

/**
 * Merges Eidentic-required Next.js config onto a user-supplied base config.
 *
 * What it does:
 * - Appends `"better-sqlite3"` to `serverExternalPackages` so the Webpack
 *   bundler never tries to bundle the native addon (which would fail).
 *
 * **If you use `@eidentic/libsql` instead of `@eidentic/sqlite`** you don't need
 * this (libsql has no native addon), but it's harmless to include anyway.
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { eidenticNextConfig } from "@eidentic/nextjs";
 * import type { NextConfig } from "next";
 *
 * const baseConfig: NextConfig = {
 *   // your existing config here
 * };
 *
 * export default eidenticNextConfig(baseConfig);
 * ```
 */
export function eidenticNextConfig(userConfig: NextConfigShape = {}): NextConfigShape {
  const existing: string[] = Array.isArray(userConfig.serverExternalPackages)
    ? (userConfig.serverExternalPackages as string[])
    : [];

  const eidentic = ["better-sqlite3"];
  // Merge without duplicates
  const merged = [...new Set([...existing, ...eidentic])];

  return {
    ...userConfig,
    serverExternalPackages: merged,
  };
}

/**
 * Minimal shape of Next.js config that this package touches.
 * Using a loose record type avoids a `next` peer dep at the type level,
 * so the package builds correctly in environments where `next` is only
 * available at runtime.
 */
export interface NextConfigShape {
  serverExternalPackages?: string[];
  [key: string]: unknown;
}
