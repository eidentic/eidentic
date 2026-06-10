import { createTool } from "@eidentic/core";
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
  send(method: string, params: unknown): Promise<unknown>;
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
    execute: async ({ input }) => {
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
        raw = await transport.send("message/send", params);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `A2A transport error: ${msg}` };
      }

      // Check for JSON-RPC error envelope: { error: { code, message } }
      if (raw != null && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (r["error"] != null) {
          const err = r["error"] as Record<string, unknown>;
          const msg = typeof err["message"] === "string" ? err["message"] : JSON.stringify(err);
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

export function httpA2ATransport(
  baseUrl: string,
  init?: { headers?: Record<string, string> },
): A2ATransport {
  const url = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return {
    async send(method: string, params: unknown): Promise<unknown> {
      const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
      const res = await fetch(url + "/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`A2A HTTP error: ${res.status} ${res.statusText}`);
      }
      return res.json();
    },
  };
}

// ---------------------------------------------------------------------------
// fetchAgentCard — GET /.well-known/agent-card.json from a remote A2A server
// ---------------------------------------------------------------------------

export async function fetchAgentCard(baseUrl: string): Promise<A2AAgentCard> {
  const url = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const res = await fetch(`${url}/.well-known/agent-card.json`);
  if (!res.ok) {
    throw new Error(`fetchAgentCard: HTTP ${res.status} ${res.statusText}`);
  }
  const card = (await res.json()) as Record<string, unknown>;
  // Validate minimal required fields
  if (typeof card["name"] !== "string") {
    throw new Error("fetchAgentCard: response missing required field 'name'");
  }
  return card as unknown as A2AAgentCard;
}

// Re-export A2AAgentCard for convenience (defined in server.ts)
export type { A2AAgentCard };
