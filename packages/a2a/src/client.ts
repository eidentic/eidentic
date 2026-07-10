import { createTool, sanitizeBoundaryText, sanitizeBoundaryValue } from "@eidentic/core";
import type { Tool } from "@eidentic/core";
import { z } from "zod";
import type { A2AAgentCard } from "./server.js";

// ---------------------------------------------------------------------------
// A2ATransport — minimal structural interface for sending JSON-RPC requests
// to a remote A2A agent. Satisfied by `httpA2ATransport` (real fetch) and by
// the in-memory fake used in tests. a2aTool stays transport-free at import time.
// Mirrors the McpClientLike / McpServerLike pattern from @eidentic/mcp.
// ---------------------------------------------------------------------------

export interface A2ATransport {
  /**
   * Send a JSON-RPC request to the remote A2A agent and return the parsed result.
   * Should throw (or return `{ error }`) on protocol errors; `a2aTool` handles both.
   */
  send(method: string, params: unknown, opts?: A2ASendOptions): Promise<unknown>;
}

export interface A2ASendOptions {
  /** Abort this individual transport call. */
  signal?: AbortSignal;
}

export interface A2AHttpOptions extends A2ASendOptions {
  headers?: Record<string, string>;
  /** Overall fetch + response-body deadline. @default 30_000 */
  timeoutMs?: number;
  /** Maximum decompressed response bytes read before aborting. @default 1_048_576 */
  maxResponseBytes?: number;
}

// ---------------------------------------------------------------------------
// Options for a2aTool
// ---------------------------------------------------------------------------

export interface A2AToolOptions {
  /** Eidentic tool id. Defaults to "a2a_agent". */
  id?: string;
  /** Shown to the model as the tool's purpose. Defaults to "Call a remote A2A agent." */
  description?: string;
  /**
   * Fixed sessionId / contextId passed in every message.
   * Defaults to a generated contextId per call when absent.
   */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Extract the reply text from a message/send result (Task or Message).
//
// A2A v0.3 confirmed shapes:
//   Task  → { kind: "task", status: { state }, history: Message[] }
//   Message → { kind: "message", parts: [{ kind: "text", text }] }
// The server-side stores history[0] as the agent reply message.
// ---------------------------------------------------------------------------

function extractText(result: unknown): string {
  if (result == null || typeof result !== "object") {
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  const r = result as Record<string, unknown>;

  // Task: extract from history[0].parts (our server always stores the reply there)
  if (r["kind"] === "task") {
    const history = r["history"];
    if (Array.isArray(history) && history.length > 0) {
      return extractText(history[0]);
    }
    // fallback: check artifacts
    const artifacts = r["artifacts"];
    if (Array.isArray(artifacts) && artifacts.length > 0) {
      return extractText(artifacts[0]);
    }
    return JSON.stringify(result);
  }

  // Message: join text parts
  if (r["kind"] === "message") {
    const parts = r["parts"];
    if (Array.isArray(parts)) {
      const texts = (parts as Array<unknown>)
        .filter((p): p is { kind: string; text: string } =>
          p != null && typeof p === "object" && (p as Record<string, unknown>)["kind"] === "text",
        )
        .map((p) => p.text);
      return texts.join("\n");
    }
  }

  // Fallback: try text field directly
  if (typeof r["text"] === "string") return r["text"];

  return JSON.stringify(result);
}

let _toolCallSeq = 0;

// ---------------------------------------------------------------------------
// a2aTool — wrap a remote A2A agent as a first-class Eidentic Tool
// ---------------------------------------------------------------------------

export function a2aTool(transport: A2ATransport, opts?: A2AToolOptions): Tool {
  return createTool({
    id: opts?.id ?? "a2a_agent",
    description: opts?.description ?? "Call a remote A2A agent via the Agent-to-Agent (A2A) protocol.",
    inputSchema: z.object({ message: z.string().describe("The message to send to the remote A2A agent.") }),
    sideEffect: "destructive", // remote agent calls are side-effecting by default
    execute: async ({ input, ctx }) => {
      const contextId =
        opts?.sessionId ??
        `ctx_${Date.now().toString(36)}_${(_toolCallSeq++).toString(36)}`;

      const messageId = `msg_client_${Date.now().toString(36)}_${(_toolCallSeq++).toString(36)}`;

      const params = {
        message: {
          kind: "message",
          messageId,
          role: "user",
          contextId,
          parts: [{ kind: "text", text: input.message }],
        },
      };

      let raw: unknown;
      try {
        raw = await transport.send("message/send", params, { signal: ctx?.signal });
      } catch (e) {
        const msg = sanitizeBoundaryText(e instanceof Error ? e.message : String(e), 500);
        return { error: `A2A transport error: ${msg}` };
      }

      // Check for JSON-RPC error envelope: { error: { code, message } }
      if (raw != null && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (r["error"] != null) {
          const err = r["error"] as Record<string, unknown>;
          const msg = typeof err["message"] === "string"
            ? sanitizeBoundaryText(err["message"], 500)
            : JSON.stringify(sanitizeBoundaryValue(err));
          return { error: `A2A error: ${msg}` };
        }
        // Unwrap JSON-RPC result envelope if present: { jsonrpc, id, result }
        if ("result" in r) {
          return { text: extractText(r["result"]) };
        }
      }

      // Bare result (no envelope): treat directly
      return { text: extractText(raw) };
    },
  });
}

// ---------------------------------------------------------------------------
// httpA2ATransport — fetch-based A2ATransport for a real remote A2A base URL
// ---------------------------------------------------------------------------

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

function positiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function createAbortContext(
  timeoutMs: number,
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const forward = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? new Error("A2A request aborted"));
    }
  };
  for (const signal of signals) {
    if (signal === undefined) continue;
    if (signal.aborted) {
      forward(signal);
      break;
    }
    const listener = () => forward(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`A2A request timed out after ${timeoutMs}ms`));
    }
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
    },
  };
}

async function cancelResponseBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readJsonResponse(
  res: Response,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelResponseBody(res);
      throw new Error(`${label} response is too large (max ${maxBytes} bytes)`);
    }
  }
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error(`${label} response body is missing`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} response is too large (max ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function httpA2ATransport(
  baseUrl: string,
  init: A2AHttpOptions = {},
): A2ATransport {
  const url = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const timeoutMs = positiveIntegerOption("timeoutMs", init.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const maxResponseBytes = positiveIntegerOption(
    "maxResponseBytes",
    init.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  return {
    async send(method: string, params: unknown, opts?: A2ASendOptions): Promise<unknown> {
      const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
      const abort = createAbortContext(timeoutMs, [init.signal, opts?.signal]);
      try {
        const res = await fetch(url + "/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
          },
          body,
          signal: abort.signal,
        });
        if (!res.ok) {
          await cancelResponseBody(res);
          throw new Error(`A2A HTTP error: ${res.status} ${res.statusText}`);
        }
        return await readJsonResponse(res, maxResponseBytes, "A2A");
      } finally {
        abort.cleanup();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// fetchAgentCard — GET /.well-known/agent-card.json from a remote A2A server
// ---------------------------------------------------------------------------

export async function fetchAgentCard(
  baseUrl: string,
  opts: A2AHttpOptions = {},
): Promise<A2AAgentCard> {
  const url = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const timeoutMs = positiveIntegerOption("timeoutMs", opts.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const maxResponseBytes = positiveIntegerOption(
    "maxResponseBytes",
    opts.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const abort = createAbortContext(timeoutMs, [opts.signal]);
  let card: unknown;
  try {
    const res = await fetch(`${url}/.well-known/agent-card.json`, {
      headers: opts.headers,
      signal: abort.signal,
    });
    if (!res.ok) {
      await cancelResponseBody(res);
      throw new Error(`fetchAgentCard: HTTP ${res.status} ${res.statusText}`);
    }
    card = await readJsonResponse(res, maxResponseBytes, "fetchAgentCard");
  } finally {
    abort.cleanup();
  }
  // Validate minimal required fields
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    throw new Error("fetchAgentCard: response must be a JSON object");
  }
  if (typeof (card as Record<string, unknown>)["name"] !== "string") {
    throw new Error("fetchAgentCard: response missing required field 'name'");
  }
  return card as unknown as A2AAgentCard;
}

// Re-export A2AAgentCard for convenience (defined in server.ts)
export type { A2AAgentCard };
