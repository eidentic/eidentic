import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeBoundaryText, sanitizeBoundaryValue } from "@eidentic/core";

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
  query(input: string, opts?: { sessionId?: string; userId?: string; orgId?: string; apiKey?: string; signal?: AbortSignal }): AsyncIterable<unknown> | Promise<unknown>;
}

export interface A2AAuthPrincipal {
  /** Stable verified task-owner identity. Preferred over credential-derived identity. */
  id?: string;
  userId?: string;
  orgId?: string;
  apiKey?: string;
}

/**
 * Auth verifier for the A2A endpoint. Receives the raw Request and must
 * return a non-empty credential/identity string to allow access, or a falsy
 * value (`false`, `null`, `undefined`, or empty string `""`) to reject.
 *
 * String credentials are SHA-256 pseudonymized before they are used as task or
 * agent-session identity; the raw value is never forwarded to Agent.query.
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
   * A truthy string return is mapped to a stable opaque caller identity;
   * `tasks/get` enforces ownership so a caller cannot retrieve
   * another caller's task.
   * When omitted, the JSON-RPC endpoint denies requests unless the explicitly
   * unsafe migration option is enabled.
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
   *     return key ?? false; // raw key is mapped to an opaque identity
   *   },
   * }
   * ```
   */
  auth?: { verify: A2AAuthVerifier };
  /** @deprecated Explicitly restore the legacy unauthenticated JSON-RPC endpoint. */
  unsafeAllowUnauthenticated?: boolean;
  /**
   * Restore the legacy behavior that forwards a raw string/API-key credential
   * into Agent.query as `apiKey`.
   *
   * @deprecated Raw credentials can be persisted in session ownership records.
   * Leave this disabled and return a verified userId/orgId/id instead.
   * @default false
   */
  allowRawCredentialIdentity?: boolean;
  /** Maximum UTF-8 bytes accepted for the JSON-RPC request body. @default 1_048_576 */
  maxBodyBytes?: number;
  /** Maximum number of message parts accepted by message/send. @default 128 */
  maxParts?: number;
  /** Maximum UTF-8 bytes across all text parts in one message. @default 262_144 */
  maxTextBytes?: number;
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
  /** Maximum concurrent agent runs accepted by this process. @default 32 */
  maxConcurrentRuns?: number;
  /** Hard wall-clock deadline for one agent run. @default 60_000 */
  maxRunMs?: number;
  /** Maximum UTF-8 bytes stored/returned from one agent result. @default 1_048_576 */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_PARTS = 128;
const DEFAULT_MAX_TEXT_BYTES = 262_144;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_RUN_MS = 60_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 32;

function positiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

class A2ARequestTooLargeError extends Error {}

async function readRequestText(req: Request, maxBytes: number): Promise<string> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new A2ARequestTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
  }
  const reader = req.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new A2ARequestTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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
class A2AOutputTooLargeError extends Error {}
class A2ARunTimeoutError extends Error {}

function assertBoundedOutput(value: string, maxOutputBytes: number): string {
  const sanitized = sanitizeBoundaryText(value, maxOutputBytes + 1);
  if (new TextEncoder().encode(sanitized).byteLength > maxOutputBytes) {
    throw new A2AOutputTooLargeError(`Agent output exceeds ${maxOutputBytes} bytes`);
  }
  return sanitized;
}

function coerceResultToString(value: unknown, maxOutputBytes: number): string {
  if (typeof value === "string") return assertBoundedOutput(value, maxOutputBytes);
  if (value != null && typeof value === "object" && "output" in (value as object)) {
    const out = (value as { output: unknown }).output;
    if (typeof out === "string") return assertBoundedOutput(out, maxOutputBytes);
    return assertBoundedOutput(JSON.stringify(sanitizeBoundaryValue(out)), maxOutputBytes);
  }
  return value !== undefined
    ? assertBoundedOutput(JSON.stringify(sanitizeBoundaryValue(value)), maxOutputBytes)
    : "";
}

/**
 * Drain an async-iterable agent response.
 *
 * Iterates all events and returns the text extracted from the final event,
 * which for a @eidentic/core Agent is `{ kind: "result", output: string }`.
 */
export async function drainIterableAgent(
  iterable: AsyncIterable<unknown>,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<string> {
  let finalEvent: unknown;
  for await (const event of iterable) {
    finalEvent = event;
  }
  return coerceResultToString(finalEvent, positiveIntegerOption("maxOutputBytes", maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES));
}

/**
 * Extract text from a plain Promise-based agent result.
 *
 * Accepts `{ output: string | unknown }`, `string`, or any JSON-serialisable
 * value as a fallback.
 */
export function drainPromiseResult(result: unknown, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  return coerceResultToString(result, positiveIntegerOption("maxOutputBytes", maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES));
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
  signal?: AbortSignal,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<string> {
  const result = await agent.query(input, { sessionId, ...(principal ?? {}), ...(signal ? { signal } : {}) });

  if (result != null && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
    return drainIterableAgent(result as AsyncIterable<unknown>, maxOutputBytes);
  }

  return drainPromiseResult(result, maxOutputBytes);
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

function publicTask(task: StoredTask): Omit<StoredTask, "owner"> {
  const { owner: _owner, ...visible } = task;
  return visible;
}

/**
 * Resolve the raw verifier return value to a caller identity string, or
 * `null` if the request should be rejected.
 *
 * - Non-empty string  → use as identity
 * - `true` (boolean)  → sentinel identity `"*"` (single-identity mode)
 * - Falsy             → reject (return null)
 */
function opaqueCredentialIdentity(credential: string): string {
  return `a2a:${createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

function compositePrincipalIdentity(parts: readonly (string | undefined)[]): string {
  // Length-delimited JSON keeps the tuple injective (unlike delimiter concatenation) while
  // avoiding disclosure of application/user/org identifiers in task ownership records.
  return `a2a-principal:${createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? null)), "utf8")
    .digest("hex")}`;
}

function resolvePrincipal(
  raw: string | boolean | A2AAuthPrincipal | null | undefined,
  allowRawCredentialIdentity: boolean,
): {
  owner: string;
  query: { userId?: string; orgId?: string; apiKey?: string };
} | null {
  if (!raw) return null;
  if (raw === true) return { owner: "*", query: {} };
  if (typeof raw === "string") {
    if (allowRawCredentialIdentity) return { owner: raw, query: { apiKey: raw } };
    const opaque = opaqueCredentialIdentity(raw);
    return { owner: opaque, query: { userId: opaque } };
  }
  const id = raw.id && raw.id.length > 0 ? raw.id : undefined;
  const userId = raw.userId && raw.userId.length > 0 ? raw.userId : undefined;
  const orgId = raw.orgId && raw.orgId.length > 0 ? raw.orgId : undefined;
  const apiKey = raw.apiKey && raw.apiKey.length > 0 ? raw.apiKey : undefined;
  const opaqueApiKey = apiKey ? opaqueCredentialIdentity(apiKey) : undefined;
  const hasAnyIdentity = [id, userId, orgId, opaqueApiKey].some((part) => part !== undefined);
  if (!hasAnyIdentity) return null;
  // Credential rotation must not change a stable verified subject's ownership identity.
  const credentialFallback = id === undefined && userId === undefined && orgId === undefined
    ? opaqueApiKey
    : undefined;
  const owner = compositePrincipalIdentity([id, userId, orgId, credentialFallback]);
  if (allowRawCredentialIdentity) {
    return {
      owner,
      query: {
        ...(userId !== undefined ? { userId } : {}),
        ...(orgId !== undefined ? { orgId } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      },
    };
  }

  return {
    owner,
    query: {
      // Always bind the downstream Agent session to a user-like subject as well as the org.
      // An org-only verifier otherwise lets every caller in that org reuse the same context.
      userId: userId ?? id ?? opaqueApiKey ?? owner,
      ...(orgId !== undefined ? { orgId } : {}),
    },
  };
}

export function a2aRoutes(opts: A2AServerOptions): Hono {
  const app = new Hono();
  const maxTasks = positiveIntegerOption("maxTasks", opts.maxTasks, 1000);
  const maxBodyBytes = positiveIntegerOption(
    "maxBodyBytes",
    opts.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
  );
  const maxParts = positiveIntegerOption("maxParts", opts.maxParts, DEFAULT_MAX_PARTS);
  const maxTextBytes = positiveIntegerOption(
    "maxTextBytes",
    opts.maxTextBytes,
    DEFAULT_MAX_TEXT_BYTES,
  );
  const maxOutputBytes = positiveIntegerOption(
    "maxOutputBytes",
    opts.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const maxRunMs = positiveIntegerOption("maxRunMs", opts.maxRunMs, DEFAULT_MAX_RUN_MS);
  const maxConcurrentRuns = positiveIntegerOption(
    "maxConcurrentRuns",
    opts.maxConcurrentRuns,
    DEFAULT_MAX_CONCURRENT_RUNS,
  );
  let activeRuns = 0;
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
    // Auth is fail-closed; legacy open mode requires an explicitly named unsafe option.
    let callerIdentity: string | undefined;
    let callerQueryIdentity: { userId?: string; orgId?: string; apiKey?: string } | undefined;
    if (opts.auth !== undefined) {
      const raw = await opts.auth.verify(c.req.raw);
      const principal = resolvePrincipal(raw, opts.allowRawCredentialIdentity === true);
      if (principal === null) {
        return c.json(rpcErr(null, -32001, "Unauthorized"), 401);
      }
      callerIdentity = principal.owner;
      callerQueryIdentity = principal.query;
    } else if (opts.unsafeAllowUnauthenticated !== true) {
      return c.json(rpcErr(null, -32001, "Unauthorized"), 401);
    }

    let rawBody: string;
    try {
      rawBody = await readRequestText(c.req.raw, maxBodyBytes);
    } catch (error) {
      if (error instanceof A2ARequestTooLargeError) {
        return c.json(rpcErr(null, ERR_INVALID_REQUEST, error.message), 413);
      }
      return c.json(rpcErr(null, ERR_PARSE, "Parse error"), 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
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
      if (parts.length > maxParts) {
        return c.json(
          rpcErr(id, ERR_INVALID_PARAMS, `Message has too many parts (max ${maxParts})`),
          413,
        );
      }

      // Extract text from user message parts (kind:"text" per A2A v0.3)
      const textParts: string[] = [];
      let textBytes = 0;
      for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const record = part as Record<string, unknown>;
        if (record["kind"] !== "text") continue;
        if (typeof record["text"] !== "string") {
          return c.json(rpcErr(id, ERR_INVALID_PARAMS, "Invalid params: text part must contain a string"), 400);
        }
        textBytes += new TextEncoder().encode(record["text"]).byteLength;
        if (textParts.length > 0) textBytes += 1; // inserted newline
        if (textBytes > maxTextBytes) {
          return c.json(
            rpcErr(id, ERR_INVALID_PARAMS, `Message text is too large (max ${maxTextBytes} bytes)`),
            413,
          );
        }
        textParts.push(record["text"]);
      }
      const text = textParts.join("\n");

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
      if (activeRuns >= maxConcurrentRuns) {
        return c.json(rpcErr(id, -32002, "Agent run capacity reached"), 503);
      }
      activeRuns++;
      const controller = new AbortController();
      const onRequestAbort = () => controller.abort(c.req.raw.signal.reason);
      c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const run = drainAgent(
        opts.agent,
        text,
        contextId,
        callerQueryIdentity,
        controller.signal,
        maxOutputBytes,
      );
      void run.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        activeRuns--;
      });
      try {
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort(new A2ARunTimeoutError("Agent run timed out"));
            reject(new A2ARunTimeoutError("Agent run timed out"));
          }, maxRunMs);
        });
        output = await Promise.race([run, timeoutResult]);
      } catch (error) {
        if (error instanceof A2ARunTimeoutError) {
          return c.json(rpcErr(id, -32003, "Agent run timed out"), 504);
        }
        if (error instanceof A2AOutputTooLargeError) {
          return c.json(rpcErr(id, -32004, error.message), 502);
        }
        return c.json(rpcErr(id, -32603, "Agent run failed"));
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        c.req.raw.signal.removeEventListener("abort", onRequestAbort);
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

      return c.json(rpcOk(id, publicTask(task)));
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
      return c.json(rpcOk(id, publicTask(task)));
    }

    // -----------------------------------------------------------------------
    // Unknown method → -32601
    // -----------------------------------------------------------------------
    return c.json(rpcErr(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`), 404);
  });

  return app;
}
