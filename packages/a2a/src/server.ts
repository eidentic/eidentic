import { Hono } from "hono";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Agent Card — the A2A well-known discovery document (GET /.well-known/agent-card.json)
// Conforms to the A2A v0.3 AgentCard shape (confirmed from @a2a-js/sdk@0.3.13 types).
// ---------------------------------------------------------------------------

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url?: string;
  version?: string;
  skills?: A2ASkill[];
}

// ---------------------------------------------------------------------------
// Minimal structural AgentLike — the surface of @eidentic/core Agent that
// serveA2A drives. The real Agent satisfies this; tests inject a fake.
// Mirrors the AgentLike pattern from @eidentic/mcp/server.ts.
// ---------------------------------------------------------------------------

export interface AgentLike {
  /**
   * Run a query and return an AsyncIterable of stream events. The terminal
   * event has kind "result" and carries an `output` field.
   * A plain Promise<unknown> is also accepted for simpler fakes.
   */
  query(input: string, opts?: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string }): AsyncIterable<unknown> | Promise<unknown>;
}

export interface A2AAuthPrincipal {
  /** Stable task-owner identity. Defaults to apiKey, userId, orgId, or "*" when omitted. */
  id?: string;
  userId?: string;
  orgId?: string;
  apiKey?: string;
}

/**
 * Auth verifier for the A2A endpoint. Receives the raw Request and must
 * return a non-empty string caller identity to allow access, or a falsy
 * value (`false`, `null`, `undefined`, or empty string `""`) to reject.
 *
 * The returned identity string is stored with each task and used to enforce
 * ownership on `tasks/get` — callers may only retrieve their own tasks.
 *
 * Legacy boolean returns are still accepted: `true` maps to the sentinel
 * identity `"*"` (single-identity mode), `false`/`null`/`undefined` rejects.
 */
export type A2AAuthVerifier = (
  req: Request,
) =>
  | string
  | boolean
  | A2AAuthPrincipal
  | null
  | undefined
  | Promise<string | boolean | A2AAuthPrincipal | null | undefined>;

export interface A2AServerOptions {
  card: A2AAgentCard;
  agent: AgentLike;
  /**
   * Optional auth guard for the `POST /` JSON-RPC endpoint.
   *
   * When provided, every `POST /` request is passed to `auth.verify(req)`.
   * A falsy return → HTTP 401 with a JSON-RPC error response.
   * A truthy string return is used as the caller identity and stored with
   * the task — `tasks/get` enforces ownership so a caller cannot retrieve
   * another caller's task.
   * When omitted, the endpoint is open and tasks are accessible without an
   * ownership check (dev / single-tenant mode).
   *
   * @warning In production, always provide an `auth` verifier to prevent
   *   unauthenticated access to your agent. The agent-card endpoint
   *   (`GET /.well-known/agent-card.json`) is intentionally kept public
   *   for A2A discovery compliance.
   *
   * Example with API key per caller:
   * ```ts
   * auth: {
   *   verify: (req) => {
   *     const key = req.headers.get("x-api-key");
   *     return key ?? false; // key string becomes the caller identity
   *   },
   * }
   * ```
   */
  auth?: { verify: A2AAuthVerifier };
  /**
   * Maximum number of tasks retained in the in-process task store.
   *
   * When the cap is reached, the oldest *settled* tasks (state "completed"
   * or "failed") are evicted first (FIFO). If all tasks are still in-flight,
   * the oldest in-flight task is evicted instead.
   *
   * @default 1000
   */
  maxTasks?: number;
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcOk(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcErr(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

// ---------------------------------------------------------------------------
// Extract text from an agent's terminal stream event or plain result
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary value returned as the terminal agent result to a string.
 * Accepts:
 *   - `{ output: string | unknown }` — Eidentic Agent terminal event shape
 *   - `string` — plain string passthrough
 *   - anything else — JSON.stringify fallback
 *
 * @internal Shared by drainIterableAgent and drainPromiseAgent.
 */
function coerceResultToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object" && "output" in (value as object)) {
    const out = (value as { output: unknown }).output;
    return typeof out === "string" ? out : JSON.stringify(out);
  }
  return value !== undefined ? JSON.stringify(value) : "";
}

/**
 * Drain an async-iterable agent response.
 *
 * Iterates all events and returns the text extracted from the final event,
 * which for a @eidentic/core Agent is `{ kind: "result", output: string }`.
 */
export async function drainIterableAgent(
  iterable: AsyncIterable<unknown>,
): Promise<string> {
  let finalEvent: unknown;
  for await (const event of iterable) {
    finalEvent = event;
  }
  return coerceResultToString(finalEvent);
}

/**
 * Extract text from a plain Promise-based agent result.
 *
 * Accepts `{ output: string | unknown }`, `string`, or any JSON-serialisable
 * value as a fallback.
 */
export function drainPromiseResult(result: unknown): string {
  return coerceResultToString(result);
}

/**
 * Dispatch to the correct drain function based on whether `agent.query()`
 * returns an async-iterable (streaming) or a plain Promise (non-streaming).
 *
 * This is the thin public dispatcher used by the A2A JSON-RPC handler.
 */
async function drainAgent(
  agent: AgentLike,
  input: string,
  sessionId: string,
  principal?: { userId?: string; orgId?: string; apiKey?: string },
): Promise<string> {
  const result = await agent.query(input, { sessionId, ...(principal ?? {}) });

  if (result != null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
    return drainIterableAgent(result as AsyncIterable<unknown>);
  }

  return drainPromiseResult(result);
}

// ---------------------------------------------------------------------------
// Build Hono routes for the A2A endpoint
//
// Routes:
//   GET  /.well-known/agent-card.json  — agent discovery card
//   POST /                             — JSON-RPC: message/send, tasks/get
//
// A2A v0.3 synchronous path only. Streaming (message/stream + SSE),
// push notifications, and OAuth are DEFERRED.
// ---------------------------------------------------------------------------

/** In-memory task store (per-app instance). */
interface StoredTask {
  id: string;
  contextId: string;
  status: { state: "completed"; timestamp: string };
  history: Array<{
    kind: "message";
    messageId: string;
    role: "agent";
    parts: Array<{ kind: "text"; text: string }>;
    contextId: string;
  }>;
  kind: "task";
  /**
   * The caller identity that created this task, as returned by
   * `auth.verify()`. `undefined` when no auth is configured (open /
   * single-tenant mode) — in that case ownership is not enforced.
   */
  owner: string | undefined;
}

/**
 * Resolve the raw verifier return value to a caller identity string, or
 * `null` if the request should be rejected.
 *
 * - Non-empty string  → use as identity
 * - `true` (boolean)  → sentinel identity `"*"` (single-identity mode)
 * - Falsy             → reject (return null)
 */
function resolvePrincipal(raw: string | boolean | A2AAuthPrincipal | null | undefined): {
  owner: string;
  query: { userId?: string; orgId?: string; apiKey?: string };
} | null {
  if (!raw) return null;
  if (raw === true) return { owner: "*", query: { apiKey: "*" } };
  if (typeof raw === "string") return { owner: raw, query: { apiKey: raw } };
  const owner = raw.id ?? raw.apiKey ?? raw.userId ?? raw.orgId;
  if (owner === undefined || owner.length === 0) return null;
  return {
    owner,
    query: {
      ...(raw.userId !== undefined ? { userId: raw.userId } : {}),
      ...(raw.orgId !== undefined ? { orgId: raw.orgId } : {}),
      ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
    },
  };
}

export function a2aRoutes(opts: A2AServerOptions): Hono {
  const app = new Hono();
  const maxTasks = opts.maxTasks ?? 1000;
  /** Ordered insertion map — Map preserves insertion order, used for FIFO eviction. */
  const taskStore = new Map<string, StoredTask>();
  const contextOwners = new Map<string, string>();

  /** Evict oldest settled tasks to stay within `maxTasks`. Falls back to evicting
   *  oldest in-flight tasks if no settled tasks exist. */
  function deleteTask(key: string): void {
    const task = taskStore.get(key);
    taskStore.delete(key);
    if (task !== undefined && ![...taskStore.values()].some((t) => t.contextId === task.contextId)) {
      contextOwners.delete(task.contextId);
    }
  }

  function evictIfNeeded(): void {
    if (taskStore.size < maxTasks) return;
    // First pass: find oldest settled task
    for (const [key, task] of taskStore) {
      const state = task.status.state as string;
      if (state === "completed" || state === "failed") {
        deleteTask(key);
        return;
      }
    }
    // Fallback: evict the oldest entry regardless of state
    const firstKey = taskStore.keys().next().value;
    if (firstKey !== undefined) deleteTask(firstKey);
  }

  // --- Agent Card (always public — A2A discovery compliance) ---
  app.get("/.well-known/agent-card.json", (c) => {
    const card = {
      name: opts.card.name,
      description: opts.card.description,
      ...(opts.card.url !== undefined ? { url: opts.card.url } : {}),
      version: opts.card.version ?? "0.0.0",
      capabilities: { streaming: false, pushNotifications: false },
      skills: (opts.card.skills ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
    };
    return c.json(card);
  });

  // --- JSON-RPC endpoint ---
  app.post("/", async (c) => {
    // Auth guard (optional; when absent the endpoint is open / single-tenant).
    let callerIdentity: string | undefined;
    let callerQueryIdentity: { userId?: string; orgId?: string; apiKey?: string } | undefined;
    if (opts.auth !== undefined) {
      const raw = await opts.auth.verify(c.req.raw);
      const principal = resolvePrincipal(raw);
      if (principal === null) {
        return c.json(rpcErr(null, -32001, "Unauthorized"), 401);
      }
      callerIdentity = principal.owner;
      callerQueryIdentity = principal.query;
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcErr(null, ERR_PARSE, "Parse error"), 400);
    }

    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(rpcErr(null, ERR_INVALID_REQUEST, "Invalid request"), 400);
    }

    const req = body as Record<string, unknown>;
    const id = req["id"] ?? null;
    const method = req["method"];
    const params = req["params"];

    if (typeof method !== "string") {
      return c.json(rpcErr(id, ERR_INVALID_REQUEST, "Invalid request: method must be a string"), 400);
    }

    // -----------------------------------------------------------------------
    // message/send — synchronous: run the agent, return a completed Task
    // -----------------------------------------------------------------------
    if (method === "message/send") {
      if (params == null || typeof params !== "object" || Array.isArray(params)) {
        return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: expected object"), 400);
      }
      const p = params as Record<string, unknown>;
      const msg = p["message"];
      if (msg == null || typeof msg !== "object" || Array.isArray(msg)) {
        return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: message missing"), 400);
      }
      const message = msg as Record<string, unknown>;
      const parts = message["parts"];
      if (!Array.isArray(parts)) {
        return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: message.parts must be an array"), 400);
      }

      // Extract text from user message parts (kind:"text" per A2A v0.3)
      const text = (parts as Array<unknown>)
        .filter((p): p is { kind: string; text: string } => p != null && typeof p === "object" && (p as Record<string, unknown>)["kind"] === "text")
        .map((p) => p.text)
        .join("\n");

      // Derive sessionId from message.contextId or generate one (Fix 3b: unguessable UUID)
      const contextId =
        typeof message["contextId"] === "string"
          ? message["contextId"]
          : randomUUID();
      if (callerIdentity !== undefined) {
        const existingOwner = contextOwners.get(contextId);
        if (existingOwner !== undefined && existingOwner !== callerIdentity) {
          return c.json(rpcErr(id, -32001, `Task not found: ${contextId}`));
        }
      }

      let output: string;
      try {
        output = await drainAgent(opts.agent, text, contextId, callerQueryIdentity);
      } catch (e) {
        const msg2 = e instanceof Error ? e.message : String(e);
        return c.json(rpcErr(id, -32603, `Agent error: ${msg2}`));
      }

      // Fix 3b: use cryptographically random UUIDs instead of guessable Date.now()-based IDs.
      const taskId = randomUUID();
      const timestamp = new Date().toISOString();

      const task: StoredTask = {
        id: taskId,
        contextId,
        kind: "task",
        status: { state: "completed", timestamp },
        history: [
          {
            kind: "message",
            messageId: randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: output }],
            contextId,
          },
        ],
        owner: callerIdentity,
      };
      evictIfNeeded();
      taskStore.set(taskId, task);
      if (callerIdentity !== undefined) contextOwners.set(contextId, callerIdentity);

      return c.json(rpcOk(id, task));
    }

    // -----------------------------------------------------------------------
    // tasks/get — return a stored task by id
    // -----------------------------------------------------------------------
    if (method === "tasks/get") {
      if (params == null || typeof params !== "object" || Array.isArray(params)) {
        return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: expected object"), 400);
      }
      const p = params as Record<string, unknown>;
      const taskId = p["id"];
      if (typeof taskId !== "string") {
        return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: id must be a string"), 400);
      }
      const task = taskStore.get(taskId);
      // Return the same not-found error for both missing and unauthorized tasks
      // so callers cannot use this endpoint as an existence oracle.
      if (!task) {
        return c.json(rpcErr(id, -32001, `Task not found: ${taskId}`));
      }
      // Ownership check: if the task has an owner and auth is configured,
      // verify the current caller matches. When no auth is configured
      // (owner === undefined), all callers may access the task.
      if (task.owner !== undefined && task.owner !== callerIdentity) {
        return c.json(rpcErr(id, -32001, `Task not found: ${taskId}`));
      }
      // Strip internal owner field before returning to caller
      const { owner: _owner, ...publicTask } = task;
      return c.json(rpcOk(id, publicTask));
    }

    // -----------------------------------------------------------------------
    // Unknown method → -32601
    // -----------------------------------------------------------------------
    return c.json(rpcErr(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`), 404);
  });

  return app;
}
