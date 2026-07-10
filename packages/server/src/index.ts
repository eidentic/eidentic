import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { credentialFingerprint, sanitizeBoundaryText, sanitizeBoundaryValue, type Agent } from "@eidentic/core";
import type {
  AuditEvent,
  AuditSink,
  AuthPort,
  AuthPrincipal,
  AuthRequest,
  RateLimiterPort,
  QuotaPort,
  SuspendDecision,
  StoredEvent,
  ContentBlock,
  EgressBoundaryPolicy,
  SafeEgressPort,
} from "@eidentic/types";
import { createWorkflowRunRegistry, WorkflowRunError } from "@eidentic/workflow";
import type { WorkflowResult, StepTrace, WorkflowRunOwner, WorkflowRunRegistry, RecordOptions } from "@eidentic/workflow";
import { InMemoryTokenBucketLimiter } from "./rate-limit.js";
import { InMemoryQuota, type QuotaReservation } from "./quota.js";

// ---------------------------------------------------------------------------
// Async run registry
//
// Tracks in-flight and completed async runs started via POST /v1/agents/:id/runs.
// Keyed by runId (UUID). The registry is in-process: a server restart will lose
// running-status entries. However, events are persisted to the store so the run's
// OUTPUT is always recoverable via the existing SSE Last-Event-ID replay path or
// the /sessions/:sid/events audit endpoint — the registry entry is only needed
// for the status poll (the "is it done yet?" signal, not the result itself).
// Durable cross-instance run tracking (e.g. via the store) is a follow-up.
// ---------------------------------------------------------------------------

/** Status of an async run. */
export type AsyncRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timed_out"
  | "suspended"
  | "guardrail"
  | "max_cost"
  | "max_tokens"
  | "max_turns"
  | "max_wall_clock";

/**
 * Registry entry for one async run.
 * `owner` mirrors the principal that started the run — used to enforce that
 * only the owning tenant may poll the run's status.
 */
export interface AsyncRunEntry {
  runId: string;
  sessionId: string;
  agentId: string;
  status: AsyncRunStatus;
  /** Text output when status is "completed". */
  output?: string;
  /** Error message when status is "failed". */
  error?: string;
  /** Principal identifiers used for ownership checks on the status endpoint. */
  owner: {
    userId?: string;
    orgId?: string;
    apiKey?: string;
  };
  createdAt: number;
  settledAt?: number;
  /** @internal Cooperative cancellation used by drain/timeout. */
  abort?: () => void;
}

/**
 * In-process registry of async runs.
 * Exported so tests and tooling can inspect entries directly when needed.
 * In production, this is a module-private detail behind the server factory.
 *
 * [M10] Bounded retention: once the registry reaches `maxRuns` entries, the
 * oldest *settled* runs (completed/failed/aborted) are evicted first.
 * In-flight runs (status="running") are never evicted. If every slot is running, `set()` returns
 * false and the caller must reject the new run; the cap is hard.
 */
export class AsyncRunRegistry {
  private readonly runs = new Map<string, AsyncRunEntry>();
  private readonly maxRuns: number;

  constructor(options?: { maxRuns?: number }) {
    this.maxRuns = options?.maxRuns ?? 1000;
    if (!Number.isSafeInteger(this.maxRuns) || this.maxRuns <= 0) {
      throw new Error("AsyncRunRegistry maxRuns must be a positive safe integer");
    }
  }

  set(entry: AsyncRunEntry): boolean {
    if (this.runs.has(entry.runId)) {
      this.runs.set(entry.runId, entry);
      return true;
    }
    if (this.runs.size >= this.maxRuns) {
      this._evictOldestSettled();
    }
    if (this.runs.size >= this.maxRuns) return false;
    this.runs.set(entry.runId, entry);
    return true;
  }

  get(runId: string): AsyncRunEntry | undefined {
    return this.runs.get(runId);
  }

  settle(runId: string, patch: Partial<AsyncRunEntry>): void {
    const entry = this.runs.get(runId);
    if (entry) {
      Object.assign(entry, patch, { settledAt: Date.now() });
    }
  }

  /** Evict the single oldest settled (non-in-flight) entry to make room. */
  private _evictOldestSettled(): void {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, e] of this.runs) {
      if (e.status !== "running" && e.createdAt < oldestAt) {
        oldestAt = e.createdAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      this.runs.delete(oldestId);
    }
  }

  /** Return all entries (copy of values). Used by graceful drain to check in-flight count. */
  values(): AsyncRunEntry[] {
    return [...this.runs.values()];
  }
}

export type { AuthPort, AuthPrincipal, AuthRequest, RateLimiterPort, QuotaPort };
export { InMemoryTokenBucketLimiter, InMemoryQuota };
export type { WorkflowRunOwner, WorkflowRunRegistry, RecordOptions } from "@eidentic/workflow";
export type { TokenBucketOptions } from "./rate-limit.js";
export type { QuotaLimits, QuotaUsage, QuotaCheck } from "@eidentic/types";
export { toUIMessageStream, toUIMessageStreamResponse } from "./ui-message-stream.js";
export type { ToUIMessageStreamOptions } from "./ui-message-stream.js";
export { Scheduler } from "./scheduler.js";
export type {
  ScheduledTask,
  Schedule,
  IntervalSchedule,
  CronSchedule,
  RunCallback,
  RunContext,
  SchedulerOptions,
  ClockPort,
  TimerPort,
} from "./scheduler.js";
export { BatchRunner } from "./batch-runner.js";
export type {
  BatchItem,
  BatchItemSuccess,
  BatchItemError,
  BatchItemResult,
  BatchAggregate,
  BatchResult,
  BatchRunnerOptions,
  BatchRunOptions,
  BatchBackend,
  OnProgress,
} from "./batch-runner.js";

// ---------------------------------------------------------------------------
// Auth adapters
// ---------------------------------------------------------------------------

/**
 * No-op auth: always returns an empty principal (single-tenant mode).
 *
 * **Warning:** When used with `exposeEvents: true` or in any multi-tenant
 * deployment, all requests are treated as the same anonymous principal.
 * Every client can read every session's events. Only use `NoAuth` for
 * trusted single-tenant environments (local dev, internal services) — do
 * NOT expose a server using `NoAuth` to the public internet.
 */
export const NoAuth: AuthPort = {
  authenticate(_req: AuthRequest): AuthPrincipal {
    return {};
  },
};

function isProductionRuntime(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV === "production";
}

function allowNoAuthInProduction(): boolean {
  if (typeof process === "undefined") return false;
  const value = process.env?.EIDENTIC_ALLOW_NO_AUTH;
  return value === "1" || value === "true";
}

function assertNoAuthAllowed(auth: AuthPort): void {
  if (auth !== NoAuth || !isProductionRuntime() || allowNoAuthInProduction()) return;
  throw new Error(
    "NoAuth is disabled when NODE_ENV=production. Configure an AuthPort or set EIDENTIC_ALLOW_NO_AUTH=1 for a trusted single-tenant deployment.",
  );
}

/**
 * API-key auth: reads `Authorization: Bearer <key>` or `x-api-key` header,
 * looks it up in the provided key→principal map, returns null on mismatch.
 *
 * `runAuth` lowercases all header keys before the adapter sees them, so only
 * the lowercase variants are reachable here. The capitalised fallback branches
 * were dead code and have been removed.
 *
 * **Security note — plain-object key lookup is not constant-time.**
 * Operators with high-security needs (timing-attack resistance) should use a
 * hashed-key comparison (e.g. HMAC) rather than a plain Map lookup. This
 * implementation is sufficient for most deployments but not for environments
 * where side-channel timing attacks are a credible threat model.
 *
 * **Prototype-pollution guard:** `Object.hasOwn` is used before the lookup so
 * that keys such as `"__proto__"`, `"constructor"`, or `"toString"` — which
 * exist on every plain object's prototype — never resolve to a principal.
 */
export function ApiKeyAuth(keys: Record<string, AuthPrincipal>): AuthPort {
  return {
    authenticate(req: AuthRequest): AuthPrincipal | null {
      const authHeader = req.headers["authorization"];
      const xApiKey = req.headers["x-api-key"];

      let key: string | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        key = authHeader.slice(7);
      } else if (xApiKey) {
        key = xApiKey;
      }

      if (!key) return null;
      // Object.hasOwn prevents prototype-pollution-style lookups:
      // keys like "__proto__" or "constructor" exist on every object's
      // prototype and must not resolve to a principal.
      if (!Object.hasOwn(keys, key)) return null;
      return keys[key] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Server options + types
// ---------------------------------------------------------------------------

export type AgentResolver = (agentId: string) => Agent | undefined;

export interface ServerOptions {
  /** Resolve an agent by id. Accepts a plain record or a resolver function. */
  agents: Record<string, Agent> | AgentResolver;
  /**
   * Authentication adapter. Defaults to `NoAuth` (single-tenant).
   *
   * **Warning:** `NoAuth` must not be used in publicly exposed multi-tenant
   * deployments — all clients share a single anonymous principal and can read
   * each other's sessions when `exposeEvents: true` is set. See `NoAuth` for details.
   */
  auth?: AuthPort;
  /** Optional base path prefix, e.g. "/api". Default "". */
  basePath?: string;
  /**
   * Expose the `GET /v1/agents/:agentId/sessions/:sessionId/events` audit
   * endpoint. Defaults to **false** (secure-by-default).
   *
   * The endpoint enforces canonical per-principal session ownership. Ownerless legacy
   * records fail closed when authentication is configured; temporary compatibility
   * access requires `allowLegacyUnownedRecords: true`. `NoAuth` remains single-tenant.
   */
  exposeEvents?: boolean;
  /**
   * Allow authenticated callers to access legacy session/workflow records that have no owner.
   * Defaults to `false` whenever a real auth adapter is configured, and `true` in `NoAuth`
   * single-tenant mode. Enable only temporarily while migrating legacy records.
   */
  allowLegacyUnownedRecords?: boolean;
  /**
   * Token-bucket rate limiter (§20.3). When set, every POST /query and /resume
   * request is checked AFTER auth resolves and BEFORE agent work begins.
   * Throttled requests receive 429 + Retry-After. When absent, the check is
   * skipped entirely — the hot path is byte-identical to the pre-rate-limit behaviour.
   */
  rateLimiter?: RateLimiterPort;
  /**
   * Derive the rate-limit bucket key from the authenticated principal and agentId.
   * Defaults to: `principal.apiKey ?? principal.userId ?? principal.orgId ?? "anonymous"`.
   */
  rateLimitKey?: (principal: AuthPrincipal, agentId: string) => string;
  /**
   * Pre-authentication rate limiter applied to all /v1 routes BEFORE auth runs.
   * Defends against unauthenticated hammering, credential brute-force, and
   * enumeration attacks that would otherwise be unthrottled.
   *
   * Keyed by client IP (see `getClientKey` for customisation). Default limit is
   * 60 requests per minute per client key using an internal `InMemoryTokenBucketLimiter`.
   *
   * Set to `null` to **explicitly disable** pre-auth rate limiting (not recommended
   * for public-facing deployments).
   *
   * When absent, an internal limiter with safe defaults (60 req/min) is used.
   */
  preAuthRateLimiter?: RateLimiterPort | null;
  /**
   * Derive the pre-auth rate-limit bucket key from the raw Hono context.
   * Defaults to the remote address from the Node.js socket (`c.env?.incoming?.socket?.remoteAddress`),
   * falling back to the constant `"unknown"` on non-Node runtimes.
   *
   * When `trustProxy: true`, the FIRST entry of the `x-forwarded-for` header is
   * used instead of the socket address.
   */
  getClientKey?: (c: import("hono").Context) => string;
  /**
   * When `true`, the first entry of the `x-forwarded-for` header is trusted as
   * the real client IP for pre-auth rate-limiting. Defaults to `false`.
   *
   * Only set this to `true` when the server is behind a trusted reverse proxy
   * that overwrites `x-forwarded-for` — otherwise clients can spoof their IP
   * to bypass the pre-auth rate limiter.
   */
  trustProxy?: boolean;
  /**
   * Per-tenant cumulative quota ledger (§20.4). When set, every POST /query and /resume
   * request is checked AFTER auth + rate-limit + body validation + agent resolution and
   * BEFORE agent work begins. Hard-cap exceeded → HTTP 402 Payment Required + JSON error body.
   * Soft-cap crossed → `X-Eidentic-Quota-Warning: soft-limit` header (still streams).
   * After a run completes the terminal usage/cost is recorded into the ledger.
   * When absent, the check is skipped — the hot path is byte-identical to the no-quota behaviour.
   *
   * Quota is checked AFTER body validation and agent resolution so that malformed requests
   * and requests for unknown agents never consume a reservation slot (Fix #4).
   */
  quota?: QuotaPort;
  /**
   * Derive the quota ledger key from the authenticated principal and agentId.
   * Defaults to the same derivation as `rateLimitKey`:
   * `principal.apiKey ?? principal.userId ?? principal.orgId ?? "anonymous"`.
   */
  quotaKey?: (principal: AuthPrincipal, agentId: string) => string;
  /**
   * Best-effort audit sink (§10.4/§15). When set, the server emits structured `AuditEvent`s for
   * security-relevant rejections at the HTTP edge: `auth.failure` (401), `quota.exceeded` (402),
   * and `ratelimit.exceeded` (429, both pre-auth and post-auth). This is the same `AuditEvent`
   * stream `Agent` emits (`tool.call` / `permission.denied` / `erasure`) — wire the same sink to
   * both for one unified audit log. A throwing sink is swallowed, never affecting a request.
   */
  onAuditEvent?: AuditSink;
  /**
   * Maximum number of characters allowed in the `input` field of /query and /runs
   * requests, and in a string `decision` on /resume requests.
   * Defaults to 32,000. Requests exceeding this limit receive a 400 error.
   */
  maxInputChars?: number;
  /**
   * [M10] Maximum number of async-run entries retained in the in-process registry.
   * Once the limit is reached, the oldest *settled* run (completed/failed/aborted)
   * is evicted to make room. In-flight runs are never evicted.
   * Defaults to 1000. Mirror of the workflow registry's bounded pattern.
   */
  maxAsyncRuns?: number;
  /** Hard wall-clock timeout for one background run. Default: 300,000 ms. */
  maxAsyncRunMs?: number;
  /**
   * Webhook delivery configuration for async runs started via `POST /v1/agents/:id/runs`.
   *
   * When provided, a `callbackUrl` field may be included in the runs request body.
   * On run completion (success or error) the server POSTs a JSON payload to that URL:
   *
   * ```json
   * { "runId": "…", "agentId": "…", "status": "completed"|"failed",
   *   "output": "…", "error": "…", "usage": { "inputTokens": 0, "outputTokens": 0 } }
   * ```
   *
   * ### Signature verification recipe
   *
   * The request carries two headers:
   * - `X-Eidentic-Timestamp` — Unix timestamp in milliseconds (string).
   * - `X-Eidentic-Signature` — `sha256=<hex HMAC-SHA256>` where the HMAC key is
   *   `signingSecret` and the message is `<timestamp>.<rawBody>`.
   *
   * To verify on your server (Node.js example):
   * ```ts
   * import { createHmac } from "node:crypto";
   *
   * function verify(secret: string, timestamp: string, rawBody: string, signature: string) {
   *   const expected = "sha256=" + createHmac("sha256", secret)
   *     .update(timestamp + "." + rawBody).digest("hex");
   *   // Use a constant-time comparison in production:
   *   return expected === signature;
   * }
   * ```
   *
   * **Delivery guarantees:** one attempt + up to 2 retries (1s, 2s backoff), 10 s timeout
   * per attempt, redirects never followed. Failures are logged but never surface to the caller.
   *
   * **Security:** `callbackUrl` must be an http/https URL with a public (non-private) host.
   * Set `allowPrivateHosts: true` ONLY in development / test environments.
   *
   * Callbacks are **disabled** unless this option is set. Sending `callbackUrl` in the
   * request body while `webhooks` is not configured returns `400 Bad Request`.
   */
  webhooks?: {
    /** HMAC-SHA256 signing secret. Used to sign every webhook delivery. */
    signingSecret: string;
    /** Central DNS/IP/redirect-aware egress boundary. Required unless the unsafe test opt-in is set. */
    egress?: SafeEgressPort;
    /** Callback hosts allowed at exact or dot-boundary subdomain scope. Default: [] (deny all). */
    allowedHosts?: readonly string[];
    /** Permit cleartext HTTP through the safe boundary. Deprecated; production default is HTTPS-only. */
    allowInsecureHttp?: boolean;
    /**
     * When `true`, private/loopback/link-local addresses are allowed as callback
     * hosts. Defaults to `false`. Only enable in controlled test environments.
     */
    /** @deprecated Unsafe test-only compatibility path that bypasses DNS-aware egress validation. */
    allowPrivateHosts?: boolean;
  };
  /**
   * CORS options passed through to the `hono/cors` middleware.
   *
   * **Default:** no CORS headers are added (safest default).
   * When provided, the middleware is applied to all routes.
   *
   * **Warning:** `{ origin: "*", credentials: true }` is rejected by browsers.
   * Do not combine a wildcard `origin` with `credentials: true`.
   *
   * @example
   * // Allow a specific origin
   * cors: { origin: "https://app.example.com", credentials: true }
   *
   * @example
   * // Allow any origin (unauthenticated public APIs only)
   * cors: { origin: "*" }
   */
  cors?: Parameters<typeof cors>[0];
  /**
   * External workflow run registry to use instead of the server's own internal one.
   *
   * When provided the server will use this registry for all `GET /v1/workflows` and
   * `GET /v1/workflows/:id` endpoints and for `handle.recordWorkflow()` / `handle.recordWorkflowError()`.
   * This enables durable or cross-instance registries (e.g. backed by a database).
   *
   * When absent, an in-memory bounded registry is created automatically.
   */
  workflowRuns?: WorkflowRunRegistry;
}

// ---------------------------------------------------------------------------
// ServerHandle — programmatic ingestion surface returned alongside the Hono app
// ---------------------------------------------------------------------------

/**
 * Workflow run summary — the shape returned in the `GET /v1/workflows` list.
 * Full detail (including trace/output/error) is available via `GET /v1/workflows/:id`.
 */
export interface WorkflowRunSummary {
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  stepCount: number;
}

/**
 * Workflow run detail — the shape returned by `GET /v1/workflows/:id`.
 * Extends `WorkflowRunSummary` with trace, optional output, and optional error.
 */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  trace: StepTrace[];
  output?: unknown;
  error?: string;
}

/**
 * Programmatic handle returned by `createServer`.
 *
 * `handle.recordWorkflow(name, result)` ingests a completed workflow run into
 * the server's registry, making it queryable via the workflow endpoints.
 * Returns the generated record `id` so callers can reference it immediately.
 */
export interface ServerHandle {
  /**
   * Ingest a completed workflow run.
   *
   * @param name   — human-readable workflow name
   * @param result — `WorkflowResult<O>` returned by `workflow.run()`
   * @param owner  — optional principal to attach for per-tenant filtering
   * @param opts   — optional record options (e.g. the workflow `version`)
   * @returns the generated record id
   */
  recordWorkflow<O>(name: string, result: WorkflowResult<O>, owner?: WorkflowRunOwner, opts?: RecordOptions): string;
  /**
   * Ingest a failed workflow run from a `WorkflowRunError`.
   * Records the partial step trace and error message so crashed runs appear
   * in the workflow run registry with `status: "error"`.
   *
   * @param err   — `WorkflowRunError` caught from `workflow.run()`
   * @param owner — optional principal to attach for per-tenant filtering
   * @param opts  — optional record options (e.g. the workflow `version`)
   * @returns the generated record id
   */
  recordWorkflowError(err: WorkflowRunError, owner?: WorkflowRunOwner, opts?: RecordOptions): string;
}

export { WorkflowRunError } from "@eidentic/workflow";

/**
 * Return value of `createServer`.
 *
 * Extends Hono so existing `const app = createServer(...)` usage remains valid:
 * `app.request(...)`, `app.fetch`, etc. all work as before.
 * `app.handle` is the programmatic ingestion surface (new, non-breaking addition).
 */
export type EidenticServer = Hono & { handle: ServerHandle };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeResolver(agents: Record<string, Agent> | AgentResolver): AgentResolver {
  if (typeof agents === "function") return agents;
  return (id: string) => agents[id];
}

async function runAuth(
  auth: AuthPort,
  req: Request,
): Promise<AuthPrincipal | null> {
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const url = new URL(req.url);
  const authReq: AuthRequest = {
    method: req.method,
    path: url.pathname,
    headers,
  };
  return auth.authenticate(authReq);
}

/** 512 KB body size cap for POST routes. */
const BODY_LIMIT = 512 * 1024;

// ---------------------------------------------------------------------------
// SSE resumability helpers
// ---------------------------------------------------------------------------

function latestPersistedTerminal(
  storedEvents: StoredEvent[],
  sessionId: string,
): Record<string, unknown> | null {
  const latestRun = [...storedEvents].reverse().find((event) => event.kind === "run_started");
  if (!latestRun) return null;
  for (let i = storedEvents.length - 1; i >= 0; i--) {
    const event = storedEvents[i]!;
    if (event.kind !== "terminal_result" || event.payload === null || typeof event.payload !== "object") continue;
    const payload = event.payload as { version?: unknown; runId?: unknown; result?: unknown };
    if (payload.version !== 1 || payload.runId !== latestRun.id || payload.result === null || typeof payload.result !== "object") continue;
    const result = payload.result as Record<string, unknown>;
    if (result["type"] !== "result" || typeof result["subtype"] !== "string") continue;
    return { ...result, sessionId, eventSeq: event.seq };
  }
  return null;
}

/**
 * Convert a StoredEvent back into its SSE wire representation.
 *
 * Only events that map cleanly to client-visible StreamEvent shapes are
 * replayed. Internal store events ("user", "checkpoint") are skipped so the
 * client receives the same event shapes as on a fresh connection.
 */
function storedEventToStreamPayload(
  ev: StoredEvent,
): Record<string, unknown> | null {
  switch (ev.kind) {
    case "assistant": {
      const payload = ev.payload as { content?: ContentBlock[] };
      return {
        type: "assistant",
        content: payload.content ?? [],
        usage: ev.meta?.usage ?? { inputTokens: 0, outputTokens: 0 },
        eventSeq: ev.seq,
      };
    }
    case "tool_result": {
      const payload = ev.payload as {
        callId: string;
        toolName: string;
        output: unknown;
        isError?: boolean;
      };
      return {
        type: "tool.result",
        callId: payload.callId,
        toolName: payload.toolName,
        output: payload.output,
        isError: payload.isError === true,
        eventSeq: ev.seq,
      };
    }
    case "compaction": {
      const payload = ev.payload as {
        before: number;
        after: number;
        stages: string[];
      };
      return {
        type: "compaction",
        sessionId: ev.sessionId,
        before: payload.before,
        after: payload.after,
        stages: payload.stages,
        eventSeq: ev.seq,
      };
    }
    case "terminal_result": {
      if (ev.payload === null || typeof ev.payload !== "object") return null;
      const payload = ev.payload as { version?: unknown; result?: unknown };
      if (payload.version !== 1 || payload.result === null || typeof payload.result !== "object") return null;
      const result = payload.result as Record<string, unknown>;
      if (result["type"] !== "result" || typeof result["subtype"] !== "string") return null;
      return { ...result, sessionId: ev.sessionId, eventSeq: ev.seq };
    }
    // "user", "checkpoint", "tool_call", "suspension", "run_started" — not replayed
    default:
      return null;
  }
}

function sanitizeStreamPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload["type"] !== "result" || payload["subtype"] !== "error") return payload;
  let details = payload["details"];
  if (details !== null && typeof details === "object") {
    const { rawOutput: _rawOutput, ...safeDetails } = details as Record<string, unknown>;
    details = safeDetails;
  }
  return {
    ...payload,
    output: "Agent run failed",
    ...(details !== undefined ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------
// Webhook helpers — SSRF guard + HMAC signing + delivery
// ---------------------------------------------------------------------------

/**
 * Minimal SSRF guard for callback URLs.
 * Allows only http/https and rejects private/loopback/link-local/metadata hosts.
 * When `allowPrivateHosts` is true the IP-range check is skipped (test environments).
 */
function assertCallbackUrl(rawUrl: string, allowPrivateHosts: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid callbackUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("callbackUrl must use http or https");
  }
  if (parsed.username || parsed.password) throw new Error("callbackUrl credentials are not allowed");
  if (!allowPrivateHosts && isCallbackHostBlocked(parsed.hostname)) {
    throw new Error("callbackUrl resolves to a blocked private/loopback/metadata host");
  }
  return parsed;
}

/** Returns true when `host` is a private/loopback/link-local/metadata address. */
function isCallbackHostBlocked(host: string): boolean {
  // Strip IPv6 brackets
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (h.toLowerCase() === "localhost") return true;

  // Dotted IPv4
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // Non-dotted IPv4 (decimal / hex 0x… / octal 0…)
  let ndInt: number | undefined;
  if (/^0x[0-9a-fA-F]+$/.test(h)) ndInt = (parseInt(h, 16)) >>> 0;
  else if (/^\d+$/.test(h)) { const n = Number(h); if (!isNaN(n) && n >= 0 && n <= 0xffffffff) ndInt = n >>> 0; }
  else if (/^0[0-7]+$/.test(h)) ndInt = (parseInt(h, 8)) >>> 0;
  if (ndInt !== undefined) {
    const a = (ndInt >>> 24) & 0xff, b = (ndInt >>> 16) & 0xff;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6
  let v6 = h.toLowerCase();
  const pct = v6.indexOf("%"); if (pct !== -1) v6 = v6.slice(0, pct);
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:h:h)
  const mapD = /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
  if (mapD) {
    const a = Number(mapD[1]), b = Number(mapD[2]);
    const n = (((Number(mapD[1]) << 24) | (Number(mapD[2]) << 16) | (Number(mapD[3]) << 8) | Number(mapD[4])) >>> 0);
    const aa = (n >>> 24) & 0xff, bb = (n >>> 16) & 0xff;
    if (aa === 0 || aa === 127 || aa === 10) return true;
    if (aa === 172 && bb >= 16 && bb <= 31) return true;
    if (aa === 192 && bb === 168) return true;
    if (aa === 169 && bb === 254) return true;
    void a; void b;
    return false;
  }
  const mapH = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapH) {
    const n = ((parseInt(mapH[1] ?? "0", 16) << 16) | parseInt(mapH[2] ?? "0", 16)) >>> 0;
    const a = (n >>> 24) & 0xff, b = (n >>> 16) & 0xff;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (v6 === "::" || v6 === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(v6)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]?(:|$)/.test(v6)) return true;   // fe80::/10 link-local
  return false;
}

/** Payload sent to a callbackUrl on run completion. */
export interface WebhookPayload {
  runId: string;
  agentId: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Deliver a webhook to `callbackUrl` with HMAC-SHA256 signature.
 *
 * Signature: `sha256=<hex HMAC(signingSecret, timestamp + "." + body)>`
 * Header `X-Eidentic-Timestamp` carries the timestamp used in signing.
 *
 * Retries: 1 attempt + 2 retries (1 s, 2 s backoff). Failures are logged
 * via `logger` and never throw. Redirects are never followed. Timeout: 10 s.
 */
async function deliverWebhook(
  callbackUrl: string,
  payload: WebhookPayload,
  signingSecret: string,
  logger: { error: (...args: unknown[]) => void },
  egress?: SafeEgressPort,
  policy?: EgressBoundaryPolicy,
  unsafeDirectFetch = false,
): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const message = timestamp + "." + body;

  // HMAC-SHA256 via Web Crypto (available in all modern Node.js / edge runtimes)
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const signature = `sha256=${hexSig}`;
  const safeCallback = (() => {
    try {
      const url = new URL(callbackUrl);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "[invalid callback URL]";
    }
  })();

  const delays = [0, 1000, 2000]; // attempt 0 immediate, retry 1 after 1s, retry 2 after 2s
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const headers = {
          "content-type": "application/json",
          "X-Eidentic-Signature": signature,
          "X-Eidentic-Timestamp": timestamp,
        };
        const status = egress && policy
          ? (await egress.request({
              url: callbackUrl,
              method: "POST",
              headers,
              body,
              signal: controller.signal,
              timeoutMs: 10_000,
              maxRedirects: 0,
              policy,
            })).status
          : unsafeDirectFetch
            ? await (async () => {
                const response = await fetch(callbackUrl, {
                  method: "POST",
                  headers,
                  body,
                  signal: controller.signal,
                  redirect: "manual",
                  credentials: "omit",
                  referrerPolicy: "no-referrer",
                });
                void response.body?.cancel().catch(() => undefined);
                return response.status;
              })()
            : 0;
        clearTimeout(timer);
        if (status >= 200 && status < 300) return; // success
        // Non-2xx — retry
        logger.error(`[eidentic/server] webhook delivery attempt ${attempt + 1} failed: HTTP ${status} for ${safeCallback}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      logger.error(`[eidentic/server] webhook delivery attempt ${attempt + 1} error for ${safeCallback}: ${err instanceof Error ? err.name : "Error"}`);
    }
  }
  logger.error(`[eidentic/server] webhook delivery exhausted retries for ${safeCallback}`);
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

/**
 * Build a Hono app exposing Eidentic agents as a REST + SSE service.
 *
 * Routes:
 *   GET  /health                                            — liveness (no auth)
 *   POST /v1/agents/:agentId/query                         — SSE-streamed query
 *   POST /v1/agents/:agentId/resume                        — SSE-streamed resume
 *   GET  /v1/agents/:agentId/sessions/:sessionId/events    — JSON audit log
 *                                                            (only when exposeEvents: true)
 *
 * ## SSE stream resumability
 *
 * Every SSE event in the `/query` and `/resume` streams carries an `id:` field
 * whose value is the corresponding `StoredEvent.seq` from the durable event log.
 * Non-persisted events (`stream.delta`) do not update the id; browsers
 * auto-carry the last seen `id` as `Last-Event-ID` on EventSource reconnect,
 * which will always be a stored-event seq.
 *
 * ### Client usage
 *
 * **Browser (EventSource — automatic)**
 * ```ts
 * const es = new EventSource(`/v1/agents/demo/query?sessionId=s1&input=hello`);
 * // On disconnect, the browser automatically reconnects with
 * // Last-Event-ID: <last seq> — the server replays missed events.
 * ```
 *
 * Note: `EventSource` only supports GET. For POST-based streams, use `fetch`
 * with a manual `Last-Event-ID` header (see below).
 *
 * **fetch / POST (manual)**
 * ```ts
 * const res = await fetch(`/v1/agents/demo/query`, {
 *   method: "POST",
 *   headers: {
 *     "content-type": "application/json",
 *     "last-event-id": "3",   // resume from seq 3
 *   },
 *   body: JSON.stringify({ input: "hello", sessionId: "s1" }),
 * });
 * ```
 *
 * ### Reconnect behaviour
 *
 * When `Last-Event-ID: N` is present on a (re)connection:
 * 1. The server enforces the same ownership check as the initial request.
 * 2. All persisted events with `seq > N` are replayed in order.
 * 3. If the session run has already completed (last assistant event has no
 *    pending tool calls), a synthesized `result` event is appended and the
 *    stream closes — no new agent work is started.
 * 4. If the run appears to still be in progress, the server falls through to
 *    live event streaming (calling `agent.query` / `agent.resume` as normal).
 *
 * The default path (no `Last-Event-ID`) is byte-compatible with prior behaviour.
 */
/** Default pre-auth rate-limit: 60 requests per minute per client key. */
const DEFAULT_PRE_AUTH_CAPACITY = 60;
const DEFAULT_PRE_AUTH_REFILL_PER_SEC = 1; // 60/min = 1/sec refill

/**
 * Derive the client key for pre-auth rate-limiting.
 * Uses socket remote address on Node.js; falls back to "unknown" on other runtimes.
 * When `trustProxy` is true, uses the first entry of `x-forwarded-for` instead.
 */
function defaultGetClientKey(c: import("hono").Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  // @hono/node-server populates c.env?.incoming with the IncomingMessage.
  // Guard for non-Node runtimes where this isn't available.
  const incoming = (c.env as Record<string, unknown> | undefined)?.["incoming"] as { socket?: { remoteAddress?: string } } | undefined;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

export function createServer(opts: ServerOptions): EidenticServer {
  const resolve = makeResolver(opts.agents);
  const auth = opts.auth ?? NoAuth;
  assertNoAuthAllowed(auth);
  const noAuthMode = auth === NoAuth;
  const allowLegacyUnownedRecords = opts.allowLegacyUnownedRecords ?? noAuthMode;
  const defaultKey = (p: AuthPrincipal, _agentId: string) => p.apiKey ?? p.userId ?? p.orgId ?? "anonymous";
  const getRateLimitKey = opts.rateLimitKey ?? defaultKey;
  const getQuotaKey = opts.quotaKey ?? defaultKey;
  const maxInputChars = opts.maxInputChars ?? 32_000;
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0) {
    throw new Error("maxInputChars must be a positive safe integer");
  }
  const maxAsyncRunMs = opts.maxAsyncRunMs ?? 300_000;
  if (!Number.isSafeInteger(maxAsyncRunMs) || maxAsyncRunMs <= 0) {
    throw new Error("maxAsyncRunMs must be a positive safe integer");
  }
  const quota = opts.quota;

  // Pre-auth rate limiter (C3 fix). `null` explicitly disables; absent = use safe default.
  const preAuthLimiter: RateLimiterPort | null =
    opts.preAuthRateLimiter === null
      ? null
      : opts.preAuthRateLimiter ??
        new InMemoryTokenBucketLimiter({
          capacity: DEFAULT_PRE_AUTH_CAPACITY,
          refillPerSec: DEFAULT_PRE_AUTH_REFILL_PER_SEC,
        });

  const trustProxy = opts.trustProxy ?? false;
  const getClientKey = opts.getClientKey
    ? opts.getClientKey
    : (c: import("hono").Context) => defaultGetClientKey(c, trustProxy);

  // Best-effort audit sink (§10.4/§15). Emits security-relevant rejections at the HTTP edge.
  // A throwing sink is swallowed so it can never break a request — same contract as the Agent.
  const onAuditEvent = opts.onAuditEvent;
  const emitAudit = (event: AuditEvent): void => {
    if (!onAuditEvent) return;
    try {
      onAuditEvent(event);
    } catch {
      /* best-effort audit: a throwing sink must never affect request handling */
    }
  };
  /** Emit an `auth.failure` audit event and return the standard 401 response. */
  const unauthorized = (c: import("hono").Context): Response => {
    emitAudit({ type: "auth.failure", at: Date.now(), route: c.req.path });
    return c.json({ error: "Unauthorized" }, 401);
  };

  // Graceful drain: when `_draining` is true, new /v1 requests get 503.
  let _draining = false;

  // strict: true — trailing-slash variants (e.g. /v1/agents/demo/query/) return 404
  // rather than being silently normalised. The full test suite passes with strict mode
  // enabled; no route depends on trailing-slash tolerance in production usage.
  const app = new Hono({ strict: true });
  const base = opts.basePath ?? "";
  const r = base ? app.basePath(base) : app;

  // ---------------------------------------------------------------------------
  // Global middleware
  // ---------------------------------------------------------------------------

  // CORS — applied when opts.cors is provided, before any other middleware.
  if (opts.cors !== undefined) {
    r.use("*", cors(opts.cors));
  }

  // H3 fix: X-Content-Type-Options: nosniff on all responses.
  r.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });

  // Graceful drain: return 503 on new /v1 requests while draining.
  r.use("/v1/*", async (c, next) => {
    if (_draining) {
      c.header("Retry-After", "5");
      return c.json({ error: "service_draining" }, 503);
    }
    await next();
  });

  // C3 fix: pre-auth rate limiter applied to all /v1 routes BEFORE auth runs.
  // Throttles unauthenticated hammering, credential brute-force, and enumeration.
  if (preAuthLimiter !== null) {
    r.use("/v1/*", async (c, next) => {
      const clientKey = getClientKey(c);
      const rl = await preAuthLimiter.acquire(clientKey);
      if (!rl.ok) {
        c.header("X-Content-Type-Options", "nosniff");
        const retryAfterSec = rl.retryAfterMs !== undefined ? Math.ceil(rl.retryAfterMs / 1000) : undefined;
        if (retryAfterSec !== undefined) {
          c.header("Retry-After", String(retryAfterSec));
        }
        emitAudit({ type: "ratelimit.exceeded", at: Date.now(), principalId: clientKey, route: c.req.path });
        return c.json({ error: "rate_limited", retryAfterMs: rl.retryAfterMs }, 429);
      }
      await next();
    });
  }

  // Async run registry — in-process, in-memory. Survives the lifetime of this server instance.
  // See AsyncRunRegistry doc comment for restart/durability notes.
  // [M10] maxRuns bounds the registry to prevent unbounded memory growth; mirrors the
  // workflow registry's bounded pattern. Configurable via opts.maxAsyncRuns.
  const asyncRuns = new AsyncRunRegistry({ maxRuns: opts.maxAsyncRuns });

  // Workflow run registry — use the injected one when provided, else create a bounded in-memory one.
  const workflowRuns: WorkflowRunRegistry = opts.workflowRuns ?? createWorkflowRunRegistry();

  // Expose the drain-flag toggle and asyncRuns accessor on the app so serveNode can call them.
  // We attach them as non-enumerable symbols to avoid polluting the public EidenticServer surface.
  const _setDraining = (v: boolean) => { _draining = v; };
  const _getAsyncRuns = () => asyncRuns;

  // --- Health ---
  r.get("/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Ownership check helper (Fix #1 / Fix 3a — IDOR prevention)
  // ---------------------------------------------------------------------------

  /** Match the canonical resource owner. User ownership takes precedence over org/apiKey. */
  async function checkOwnership(
    session: { userId?: string; orgId?: string; apiKey?: string },
    principal: AuthPrincipal,
  ): Promise<boolean> {
    if (noAuthMode) return true;
    if (session.userId !== undefined) return principal.userId === session.userId;
    if (session.orgId !== undefined) return principal.orgId === session.orgId;
    if (session.apiKey !== undefined) {
      if (principal.apiKey === undefined) return false;
      return session.apiKey === principal.apiKey || session.apiKey === await credentialFingerprint(principal.apiKey);
    }
    return allowLegacyUnownedRecords;
  }

  // ---------------------------------------------------------------------------
  // runAgentStream — shared SSE-streaming core for /query and /resume
  //
  // Handles: Last-Event-ID validation, quota check + soft-cap header, SSE setup,
  // replay path, live event pump, error sanitization (M8), quota settle (A8).
  //
  // The two handlers differ only in:
  //   • `sessionId` derivation (query generates one; resume uses body field)
  //   • `agentIterable` — the async iterable returned by agent.query / agent.resume
  //   • whether an initial `session=<id>` SSE comment is emitted (query only)
  // ---------------------------------------------------------------------------

  type AgentIterable = AsyncIterable<{
    type: string;
    subtype?: string;
    output?: unknown;
    eventSeq?: number;
    usage: { inputTokens: number; outputTokens: number };
    cost?: { usd?: number };
    [k: string]: unknown;
  }>;

  /**
   * Core SSE streaming helper shared by /query and /resume.
   *
   * @param c             — Hono context (must have auth already satisfied upstream)
   * @param agent         — resolved Agent instance
   * @param agentId       — route param (for quota key derivation)
   * @param principal     — authenticated principal
   * @param sessionId     — session id to stream into
   * @param getIterable   — factory called inside the SSE callback to produce the agent AsyncIterable
   * @param logTag        — identifies the route in server-side error logs (e.g. "agent.query")
   * @param emitSessionComment — when true, emit `: session=<id>` as the first SSE comment
   * @param resumeRoute   — permits a persisted suspended terminal to continue via agent.resume
   */
  async function runAgentStream(
    c: import("hono").Context,
    agent: Agent,
    agentId: string,
    principal: AuthPrincipal,
    sessionId: string,
    getIterable: () => AgentIterable,
    logTag: string,
    emitSessionComment: boolean,
    resumeRoute: boolean,
  ): Promise<Response> {
    // ---------------------------------------------------------------------------
    // SSE resumability: parse Last-Event-ID header (M9 fix: validate before use)
    // ---------------------------------------------------------------------------
    const rawLastEventId = c.req.header("last-event-id");
    let lastEventId: number | undefined;
    if (rawLastEventId !== undefined) {
      const parsed = parseInt(rawLastEventId, 10);
      if (isNaN(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
        // M9 fix: malformed or negative Last-Event-ID → 400.
        return c.json({ error: "Invalid Last-Event-ID: must be a non-negative integer" }, 400);
      }
      lastEventId = parsed;
    }
    const hasLastEventId = lastEventId !== undefined;

    // Quota (§20.4) — checked AFTER body validation + agent resolution so that malformed
    // and unknown-agent requests never consume a reservation slot (Fix #4).
    let streamQuotaKey: string | undefined;
    let streamQuotaReservation: QuotaReservation | undefined;
    if (quota) {
      streamQuotaKey = getQuotaKey(principal, agentId);
      const qc = await quota.check(streamQuotaKey);
      if (!qc.ok) {
        emitAudit({ type: "quota.exceeded", at: Date.now(), scopeKey: streamQuotaKey, ...(qc.reason !== undefined ? { reason: qc.reason } : {}) });
        return c.json({ error: "quota_exceeded", reason: qc.reason, usage: qc.usage }, 402);
      }
      if (qc.warn) c.header("X-Eidentic-Quota-Warning", "soft-limit");
      // A8: capture the reservation token so record() can settle it (reserve-then-settle).
      streamQuotaReservation = (qc as { reservation?: QuotaReservation }).reservation;
    }

    // Guard against undefined signal on adapters that don't populate it.
    const signal = c.req.raw.signal ?? new AbortController().signal;
    return streamSSE(c, async (stream) => {
      // Optionally emit sessionId as an initial SSE comment (query path only).
      // Strip CR/LF to prevent SSE-framing injection from a client-supplied sessionId.
      if (emitSessionComment) {
        await stream.writeln(`: session=${sessionId.replace(/[\r\n]/g, "")}`);
      }

      // -----------------------------------------------------------------------
      // Replay path: client reconnected with Last-Event-ID
      // -----------------------------------------------------------------------
      if (hasLastEventId) {
        const storedEvents = await agent.store.readEvents(sessionId);
        const toReplay = storedEvents.filter((e) => e.seq > lastEventId!);

        for (const ev of toReplay) {
          if (signal.aborted) break;
          const rawPayload = storedEventToStreamPayload(ev);
          const payload = rawPayload === null ? null : sanitizeStreamPayload(rawPayload);
          if (payload !== null) {
            await stream.writeSSE({
              event: payload["type"] as string,
              data: JSON.stringify(payload),
              id: String(ev.seq),
            });
          }
        }

        // A persisted terminal is authoritative. It was replayed above when its seq was newer
        // than the cursor; when already acknowledged we simply close without synthesizing a
        // different result. Suspension alone falls through only on the explicit resume route.
        const persistedTerminal = latestPersistedTerminal(storedEvents, sessionId);
        if (
          persistedTerminal !== null &&
          !(resumeRoute && persistedTerminal["subtype"] === "suspended")
        ) {
          // Release quota reservation — no new agent work was done.
          if (quota && streamQuotaReservation !== undefined) {
            quota.release?.(streamQuotaReservation);
          }
          return;
        }
        // Run appears still in-progress (e.g. server restart mid-run); fall through
        // to live streaming below, which will run from the agent normally.
      }

      // -----------------------------------------------------------------------
      // Live streaming path (fresh connection or in-progress reconnect)
      // -----------------------------------------------------------------------

      // Track the last terminal result event so we can record spend after streaming.
      let terminalResult: { usage: { inputTokens: number; outputTokens: number }; cost?: { usd?: number } } | undefined;

      try {
        for await (const ev of getIterable()) {
          if (signal.aborted) break;

          const payload = sanitizeStreamPayload(ev as unknown as Record<string, unknown>);
          await stream.writeSSE({
            event: ev.type,
            data: JSON.stringify(payload),
            ...(Number.isSafeInteger(ev.eventSeq) ? { id: String(ev.eventSeq) } : {}),
          });

          // Capture terminal result for quota recording.
          if (ev.type === "result") {
            terminalResult = { usage: ev.usage, cost: ev.cost };
          }
        }
      } catch (err: unknown) {
        // A8: release the reservation on error so the run doesn't count against the cap.
        if (quota && streamQuotaReservation !== undefined) {
          quota.release?.(streamQuotaReservation);
          streamQuotaReservation = undefined; // prevent double-release in finally
        }
        if (!signal.aborted) {
          // M8 fix: emit a generic message in the SSE payload; log the real error server-side.
          // This prevents provider keys/stack traces from leaking to clients.
          console.error(`[eidentic/server] ${logTag} error`, {
            name: err instanceof Error ? err.name : "Error",
          });
          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              type: "result",
              subtype: "error",
              output: "Agent run failed",
              usage: { inputTokens: 0, outputTokens: 0 },
              numTurns: 0,
              sessionId,
            }),
          });
        }
      }

      // Record spend into the quota ledger (§20.4) after the run completes.
      // A8: pass the reservation token so check's in-flight count is settled correctly.
      if (quota && streamQuotaKey !== undefined && terminalResult) {
        const tokens = terminalResult.usage.inputTokens + terminalResult.usage.outputTokens;
        const usd = terminalResult.cost?.usd ?? 0;
        await quota.record(streamQuotaKey, { usd, tokens }, streamQuotaReservation);
      } else if (quota && streamQuotaReservation !== undefined && !terminalResult) {
        // No terminal result (e.g. SSE stream was aborted): release the reservation.
        quota.release?.(streamQuotaReservation);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Shared post-auth rate-limit helper (C3 fix)
  // ---------------------------------------------------------------------------
  async function checkPostAuthRateLimit(c: import("hono").Context, principal: AuthPrincipal, agentId: string): Promise<Response | null> {
    if (!opts.rateLimiter) return null;
    const baseKey = getRateLimitKey(principal, agentId);
    const rlKey = baseKey === "anonymous" ? `anon:${getClientKey(c)}` : baseKey;
    const rl = await opts.rateLimiter.acquire(rlKey);
    if (!rl.ok) {
      const retryAfterSec = rl.retryAfterMs !== undefined ? Math.ceil(rl.retryAfterMs / 1000) : undefined;
      if (retryAfterSec !== undefined) c.header("Retry-After", String(retryAfterSec));
      emitAudit({ type: "ratelimit.exceeded", at: Date.now(), principalId: rlKey, route: c.req.path });
      return c.json({ error: "rate_limited", retryAfterMs: rl.retryAfterMs }, 429);
    }
    return null;
  }

  // --- Query ---
  r.post(
    "/v1/agents/:agentId/query",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      // Auth
      const principal = await runAuth(auth, c.req.raw);
      if (principal === null) return unauthorized(c);

      const agentId = c.req.param("agentId");

      // C3 fix: post-auth rate limit.
      const rlErr = await checkPostAuthRateLimit(c, principal, agentId);
      if (rlErr) return rlErr;

      // Body validation — must happen BEFORE quota.check() so malformed requests never
      // consume a reservation slot (Fix #4: quota reservation leak on early return paths).
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>)["input"] !== "string" ||
        (body as Record<string, unknown>)["input"] === ""
      ) {
        return c.json({ error: "Missing or invalid 'input' field" }, 400);
      }
      const { input, sessionId: bodySessionId } = body as { input: string; sessionId?: unknown };

      // M7 fix: per-field cap on input length.
      if (input.length > maxInputChars) {
        return c.json({ error: `Input exceeds maximum length of ${maxInputChars} characters` }, 400);
      }

      // Agent resolution — also before quota.check() so unknown-agent requests never
      // consume a reservation slot (Fix #4: quota reservation leak on early return paths).
      const agent = resolve(agentId);
      if (!agent) {
        // H3 fix: do not echo back user-supplied agentId.
        return c.json({ error: "Not found" }, 404);
      }

      const sessionId =
        typeof bodySessionId === "string" && bodySessionId.length > 0
          ? bodySessionId
          : crypto.randomUUID();

      // Fix #1 (IDOR on /query) — verify ownership BEFORE reserving quota or streaming.
      // If the client supplied a sessionId that belongs to a different principal, reject early.
      // New sessions (no existing record) are fine; ownership is established on first write.
      if (typeof bodySessionId === "string" && bodySessionId.length > 0) {
        const sessionRecord = await agent.store.getSession(bodySessionId);
        if (sessionRecord && !await checkOwnership(sessionRecord, principal)) {
          return c.json({ error: "Forbidden" }, 403);
        }
      }

      return runAgentStream(
        c, agent, agentId, principal, sessionId,
        () => agent.query(input, {
          sessionId,
          userId: principal.userId,
          orgId: principal.orgId,
          // H1 fix: pass apiKey so apiKey-only principals own their sessions.
          apiKey: principal.apiKey,
          signal: c.req.raw.signal ?? new AbortController().signal,
        }) as AgentIterable,
        "agent.query",
        /* emitSessionComment */ true,
        /* resumeRoute */ false,
      );
    },
  );

  // --- Resume ---
  r.post(
    "/v1/agents/:agentId/resume",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      const principal = await runAuth(auth, c.req.raw);
      if (principal === null) return unauthorized(c);

      const agentId = c.req.param("agentId");

      // C3 fix: post-auth rate limit.
      const rlErr = await checkPostAuthRateLimit(c, principal, agentId);
      if (rlErr) return rlErr;

      // Body validation — must happen BEFORE quota.check() so malformed requests never
      // consume a reservation slot (Fix #4: quota reservation leak on early return paths).
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>)["sessionId"] !== "string" ||
        (body as Record<string, unknown>)["sessionId"] === ""
      ) {
        return c.json({ error: "Missing or invalid 'sessionId' field" }, 400);
      }
      const rawDecision = (body as Record<string, unknown>)["decision"];
      if (rawDecision !== undefined && (
        typeof rawDecision !== "object" || rawDecision === null || Array.isArray(rawDecision) ||
        typeof (rawDecision as Record<string, unknown>)["approved"] !== "boolean"
      )) {
        return c.json({ error: "Invalid 'decision': expected { approved: boolean, data?: unknown }" }, 400);
      }

      const sessionId = (body as { sessionId: string }).sessionId;
      const decision = rawDecision as SuspendDecision | undefined;

      // Agent resolution — also before quota.check() so unknown-agent requests never
      // consume a reservation slot (Fix #4: quota reservation leak on early return paths).
      const agent = resolve(agentId);
      if (!agent) {
        // H3 fix: do not echo back user-supplied agentId.
        return c.json({ error: "Not found" }, 404);
      }

      // Fix 3a — IDOR: verify session ownership before resuming.
      const sessionRecord = await agent.store.getSession(sessionId);
      if (sessionRecord && !await checkOwnership(sessionRecord, principal)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      return runAgentStream(
        c, agent, agentId, principal, sessionId,
        () => agent.resume(sessionId, {
          userId: principal.userId,
          orgId: principal.orgId,
          apiKey: principal.apiKey,
          decision,
          signal: c.req.raw.signal ?? new AbortController().signal,
        }) as AgentIterable,
        "agent.resume",
        /* emitSessionComment */ false,
        /* resumeRoute */ true,
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Async fire-and-poll run (D-F3)
  //
  // POST /v1/agents/:agentId/runs
  //   Accepts the same body as /query (input, optional sessionId).
  //   Runs auth + rate-limit + body validation + agent resolution + quota BEFORE
  //   accepting the run (identical guard ordering to /query). Returns 202 immediately
  //   with { runId, sessionId, status: "running" } and kicks off a background Promise
  //   that streams the agent run into the store (events are persisted normally).
  //
  // GET /v1/agents/:agentId/runs/:runId/status
  //   Returns { status, sessionId, output?, error? } for the given run.
  //   Enforces that the polling principal is the same owner that started the run.
  //   Run events are always persisted in the store so the result is recoverable
  //   via the existing /query?Last-Event-ID or /sessions/:sid/events paths even
  //   after a registry miss (e.g. server restart loses the in-memory entry).
  // ---------------------------------------------------------------------------

  r.post(
    "/v1/agents/:agentId/runs",
    bodyLimit({ maxSize: BODY_LIMIT }),
    async (c) => {
      // Auth
      const principal = await runAuth(auth, c.req.raw);
      if (principal === null) return unauthorized(c);

      const agentId = c.req.param("agentId");

      // C3 fix: post-auth rate limit with per-client anonymous bucket.
      const rlErr = await checkPostAuthRateLimit(c, principal, agentId);
      if (rlErr) return rlErr;

      // Body validation — before quota check (Fix #4: no reservation leak on early returns)
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as Record<string, unknown>)["input"] !== "string" ||
        (body as Record<string, unknown>)["input"] === ""
      ) {
        return c.json({ error: "Missing or invalid 'input' field" }, 400);
      }
      const { input, sessionId: bodySessionId, callbackUrl: rawCallbackUrl } = body as {
        input: string;
        sessionId?: unknown;
        callbackUrl?: unknown;
      };

      // M7 fix: per-field cap on input length.
      if (input.length > maxInputChars) {
        return c.json({ error: `Input exceeds maximum length of ${maxInputChars} characters` }, 400);
      }

      // Validate callbackUrl — only allowed when webhooks are configured.
      let validatedCallbackUrl: string | undefined;
      let validatedWebhookPolicy: EgressBoundaryPolicy | undefined;
      if (rawCallbackUrl !== undefined) {
        if (!opts.webhooks) {
          return c.json({ error: "Webhook callbacks are not configured on this server" }, 400);
        }
        if (typeof rawCallbackUrl !== "string" || rawCallbackUrl.length === 0) {
          return c.json({ error: "callbackUrl must be a non-empty string" }, 400);
        }
        try {
          const unsafePrivate = opts.webhooks.allowPrivateHosts === true;
          const policy: EgressBoundaryPolicy = {
            allowedHosts: opts.webhooks.allowedHosts ?? [],
            requireHttps: opts.webhooks.allowInsecureHttp !== true,
          };
          if (!unsafePrivate) {
            if (!opts.webhooks.egress) throw new Error("Webhook callbacks require a SafeEgressPort");
            await opts.webhooks.egress.validate(rawCallbackUrl, policy);
            validatedWebhookPolicy = policy;
          }
          const u = assertCallbackUrl(rawCallbackUrl, unsafePrivate);
          u.hash = "";
          validatedCallbackUrl = u.href;
        } catch (err: unknown) {
          return c.json({ error: err instanceof Error ? err.message : "Invalid callbackUrl" }, 400);
        }
      }

      // Agent resolution — before quota check (Fix #4)
      const agent = resolve(agentId);
      if (!agent) {
        // H3 fix: do not echo back user-supplied agentId.
        return c.json({ error: "Not found" }, 404);
      }

      const sessionId =
        typeof bodySessionId === "string" && bodySessionId.length > 0
          ? bodySessionId
          : crypto.randomUUID();

      // Ownership: reject cross-tenant session reuse
      if (typeof bodySessionId === "string" && bodySessionId.length > 0) {
        const sessionRecord = await agent.store.getSession(bodySessionId);
        if (sessionRecord && !await checkOwnership(sessionRecord, principal)) {
          return c.json({ error: "Forbidden" }, 403);
        }
      }

      // Quota — after body validation + agent resolution (Fix #4)
      let asyncQuotaKey: string | undefined;
      let asyncQuotaReservation: QuotaReservation | undefined;
      if (quota) {
        asyncQuotaKey = getQuotaKey(principal, agentId);
        const qc = await quota.check(asyncQuotaKey);
        if (!qc.ok) {
          emitAudit({ type: "quota.exceeded", at: Date.now(), scopeKey: asyncQuotaKey, ...(qc.reason !== undefined ? { reason: qc.reason } : {}) });
          return c.json({ error: "quota_exceeded", reason: qc.reason, usage: qc.usage }, 402);
        }
        asyncQuotaReservation = (qc as { reservation?: QuotaReservation }).reservation;
      }

      // Register the run entry before starting the background Promise so the
      // status endpoint can observe it immediately (even as "running").
      const runId = crypto.randomUUID();
      const runController = new AbortController();
      const ownerApiKey = principal.apiKey !== undefined ? await credentialFingerprint(principal.apiKey) : undefined;
      const accepted = asyncRuns.set({
        runId,
        sessionId,
        agentId,
        status: "running",
        owner: {
          userId: principal.userId,
          orgId: principal.orgId,
          apiKey: ownerApiKey,
        },
        createdAt: Date.now(),
        abort: () => runController.abort(new Error("async run cancelled")),
      });
      if (!accepted) {
        if (quota && asyncQuotaReservation !== undefined) quota.release?.(asyncQuotaReservation);
        return c.json({ error: "async_run_capacity", retryable: true }, 503);
      }

      // Fire-and-forget: run the agent in the background.
      // Events are persisted to the store exactly as in the synchronous /query path.
      // The registry entry is updated on settle so polls can observe the final status.
      (async () => {
        let terminalOutput: string | undefined;
        let terminalError: string | undefined;
        let terminalUsage: { inputTokens: number; outputTokens: number } | undefined;
        let terminalResult: { usage: { inputTokens: number; outputTokens: number }; cost?: { usd?: number } } | undefined;
        let terminalSubtype: Exclude<AsyncRunStatus, "running" | "timed_out"> | undefined;
        let localReservation: QuotaReservation | undefined = asyncQuotaReservation;
        let timedOut = false;
        const runTimer = setTimeout(() => {
          timedOut = true;
          runController.abort(new Error("async run timed out"));
        }, maxAsyncRunMs);

        try {
          for await (const ev of agent.query(input, {
            sessionId,
            userId: principal.userId,
            orgId: principal.orgId,
            apiKey: principal.apiKey,
            signal: runController.signal,
          })) {
            if (ev.type === "result") {
              terminalResult = { usage: ev.usage, cost: ev.cost };
              terminalUsage = ev.usage;
              terminalSubtype = ev.subtype === "success" ? "completed"
                : ev.subtype === "error" ? "failed"
                  : ev.subtype;
              if (ev.subtype === "success") {
                terminalOutput = typeof ev.output === "string" ? ev.output : ev.output !== undefined ? String(ev.output) : undefined;
              } else {
                terminalError = ev.subtype === "error" ? "Agent run failed" : `Agent run terminated: ${ev.subtype}`;
              }
            }
          }

          if (!terminalSubtype) {
            terminalSubtype = "failed";
            terminalError = "Agent run ended without a terminal result";
          }

          // Record quota spend on success
          if (quota && asyncQuotaKey !== undefined && terminalResult) {
            const tokens = terminalResult.usage.inputTokens + terminalResult.usage.outputTokens;
            const usd = terminalResult.cost?.usd ?? 0;
            await quota.record(asyncQuotaKey, { usd, tokens }, localReservation);
            localReservation = undefined;
          }

          const finalStatus: AsyncRunStatus = timedOut ? "timed_out" : terminalSubtype;
          asyncRuns.settle(runId, {
            status: finalStatus,
            output: terminalOutput,
            error: terminalError,
          });

          // Deliver webhook callback if configured
          if (validatedCallbackUrl && opts.webhooks) {
            const webhookPayload: WebhookPayload = {
              runId,
              agentId,
              status: finalStatus === "completed" ? "completed" : "failed",
              ...(terminalOutput !== undefined ? { output: terminalOutput } : {}),
              ...(terminalError !== undefined ? { error: terminalError } : {}),
              ...(terminalUsage !== undefined ? { usage: terminalUsage } : {}),
            };
            void deliverWebhook(
              validatedCallbackUrl,
              webhookPayload,
              opts.webhooks.signingSecret,
              console,
              opts.webhooks.egress,
              validatedWebhookPolicy,
              opts.webhooks.allowPrivateHosts === true,
            );
          }
        } catch (err: unknown) {
          // Release quota reservation on error
          if (quota && localReservation !== undefined) {
            quota.release?.(localReservation);
            localReservation = undefined;
          }
          const msg = timedOut ? "Agent run timed out" : "Agent run failed";
          asyncRuns.settle(runId, { status: timedOut ? "timed_out" : "failed", error: msg });

          // Deliver webhook callback for failed run
          if (validatedCallbackUrl && opts.webhooks) {
            const webhookPayload: WebhookPayload = {
              runId,
              agentId,
              status: "failed",
              error: msg,
              ...(terminalUsage !== undefined ? { usage: terminalUsage } : {}),
            };
            void deliverWebhook(
              validatedCallbackUrl,
              webhookPayload,
              opts.webhooks.signingSecret,
              console,
              opts.webhooks.egress,
              validatedWebhookPolicy,
              opts.webhooks.allowPrivateHosts === true,
            );
          }
        } finally {
          clearTimeout(runTimer);
          // Safety net: release any unsettled reservation (e.g. aborted without terminalResult)
          if (quota && localReservation !== undefined && !terminalResult) {
            quota.release?.(localReservation);
          }
        }
      })();

      return c.json({ runId, sessionId, status: "running" }, 202);
    },
  );

  // --- Poll async run status ---
  r.get("/v1/agents/:agentId/runs/:runId/status", async (c) => {
    // Auth
    const principal = await runAuth(auth, c.req.raw);
    if (principal === null) {
      return unauthorized(c);
    }

    const agentId = c.req.param("agentId");
    const agent = resolve(agentId);
    if (!agent) {
      // H3 fix: do not echo back user-supplied agentId.
      return c.json({ error: "Not found" }, 404);
    }

    const runId = c.req.param("runId");
    const entry = asyncRuns.get(runId);
    if (!entry) {
      // H3 fix: do not echo back user-supplied runId.
      return c.json({ error: "Not found" }, 404);
    }

    // Ownership enforcement: only the starting principal may poll.
    const ownerMatches = await checkOwnership(entry.owner, principal);

    if (!ownerMatches) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const response: Record<string, unknown> = {
      runId: entry.runId,
      sessionId: entry.sessionId,
      status: entry.status,
    };
    if (entry.output !== undefined) response["output"] = entry.output;
    if (entry.error !== undefined) response["error"] = entry.error;
    if (entry.settledAt !== undefined) response["settledAt"] = entry.settledAt;

    return c.json(response, 200);
  });

  // --- Session events (audit log) ---
  // Opt-in (exposeEvents: true). Fix 3a enforces per-principal session ownership:
  // sessions with a recorded owner require the principal to match that owner.
  // Legacy sessions (no recorded owner) are allowed through for back-compat.
  // When exposeEvents is false (default) the route returns 404.
  if (opts.exposeEvents === true) {
    r.get("/v1/agents/:agentId/sessions/:sessionId/events", async (c) => {
      const principal = await runAuth(auth, c.req.raw);
      if (principal === null) {
        return unauthorized(c);
      }

      const agentId = c.req.param("agentId");
      const agent = resolve(agentId);
      if (!agent) {
        // H3 fix: do not echo back user-supplied agentId.
        return c.json({ error: "Not found" }, 404);
      }

      const sessionId = c.req.param("sessionId");

      // Fix 3a — IDOR: verify session ownership before reading events.
      const sessionRecord = await agent.store.getSession(sessionId);
      if (sessionRecord && !await checkOwnership(sessionRecord, principal)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const events = await agent.store.readEvents(sessionId);
      return c.json({ events });
    });
  }

  // ---------------------------------------------------------------------------
  // Workflow run endpoints
  //
  // GET /v1/workflows
  //   Returns the list of recorded workflow runs, newest first, as summaries:
  //   [{ id, name, status, startedAt, durationMs, stepCount }]
  //   Auth-gated (same auth adapter as the agent routes).
  //
  // GET /v1/workflows/:id
  //   Returns the full detail for a single workflow run:
  //   { id, name, status, startedAt, durationMs, stepCount, trace, output?, error? }
  //   Returns 404 for unknown ids.
  //   Auth-gated.
  //
  // Programmatic ingestion is via `handle.recordWorkflow(name, result)` (below).
  // ---------------------------------------------------------------------------

  /** Match workflow ownership using the same canonical rules as sessions and async runs. */
  async function checkWorkflowOwnership(rec: { owner?: { userId?: string; orgId?: string; apiKey?: string } }, principal: AuthPrincipal): Promise<boolean> {
    const owner = rec.owner;
    return checkOwnership(owner ?? {}, principal);
  }

  r.get("/v1/workflows", async (c) => {
    const principal = await runAuth(auth, c.req.raw);
    if (principal === null) {
      return unauthorized(c);
    }

    const visibleRuns: ReturnType<WorkflowRunRegistry["list"]> = [];
    for (const rec of workflowRuns.list()) if (await checkWorkflowOwnership(rec, principal)) visibleRuns.push(rec);
    const summaries: WorkflowRunSummary[] = visibleRuns.map((rec) => ({
        id: rec.id,
        name: rec.name,
        status: rec.status,
        startedAt: rec.startedAt,
        durationMs: rec.durationMs,
        stepCount: rec.stepCount,
      }));

    return c.json(summaries, 200);
  });

  r.get("/v1/workflows/:id", async (c) => {
    const principal = await runAuth(auth, c.req.raw);
    if (principal === null) {
      return unauthorized(c);
    }

    const id = c.req.param("id");
    const rec = workflowRuns.get(id);
    // H3 fix: Return 404 on ownership mismatch (no existence oracle — same as not-found).
    // Do not echo back the user-supplied id in the error body.
    if (!rec || !await checkWorkflowOwnership(rec, principal)) {
      return c.json({ error: "Not found" }, 404);
    }

    const detail: WorkflowRunDetail = {
      id: rec.id,
      name: rec.name,
      status: rec.status,
      startedAt: rec.startedAt,
      durationMs: rec.durationMs,
      stepCount: rec.stepCount,
      trace: rec.trace,
      ...(rec.output !== undefined ? { output: sanitizeBoundaryValue(rec.output) } : {}),
      ...(rec.error !== undefined ? { error: sanitizeBoundaryText(rec.error, 1_000) } : {}),
    };

    return c.json(detail, 200);
  });

  // Attach the programmatic handle to the Hono app instance so callers get both
  // `app.request(...)` behaviour AND `app.handle.recordWorkflow(...)` ingestion.
  const handle: ServerHandle = {
    recordWorkflow<O>(name: string, result: WorkflowResult<O>, owner?: WorkflowRunOwner, opts?: RecordOptions): string {
      const safeResult: WorkflowResult<O> = {
        output: sanitizeBoundaryValue(result.output) as O,
        trace: result.trace.map((step) => ({
          ...step,
          ...(step.error !== undefined ? { error: sanitizeBoundaryText(step.error, 1_000) } : {}),
        })),
      };
      const rec = workflowRuns.record(name, safeResult, owner, opts);
      return rec.id;
    },
    recordWorkflowError(err: WorkflowRunError, owner?: WorkflowRunOwner, opts?: RecordOptions): string {
      const msg = sanitizeBoundaryText(
        err.cause instanceof Error ? err.cause.message : String(err.cause ?? err.message),
        1_000,
      );
      const trace = err.trace.map((step) => ({
        ...step,
        ...(step.error !== undefined ? { error: sanitizeBoundaryText(step.error, 1_000) } : {}),
      }));
      const rec = workflowRuns.recordError(err.workflowName, trace, msg, owner, opts);
      return rec.id;
    },
  };

  // Expose drain internals for serveNode (non-enumerable to avoid polluting the public API).
  Object.defineProperties(app, {
    _setDraining: { value: _setDraining, enumerable: false, writable: false },
    _getAsyncRuns: { value: _getAsyncRuns, enumerable: false, writable: false },
  });

  return Object.assign(app, { handle }) as EidenticServer;
}

// ---------------------------------------------------------------------------
// serveNode — thin wrapper over @hono/node-server (optional dep)
// ---------------------------------------------------------------------------

export interface ServeNodeHandle {
  close(): void;
  /**
   * Gracefully drain the server:
   * 1. Stops accepting new connections.
   * 2. Returns `503 Service Unavailable` (with `Retry-After: 5`) to any new
   *    `/v1/*` requests that arrive while draining.
   * 3. Waits until all in-flight async runs settle (polls every 100 ms), or
   *    until `timeoutMs` elapses.
   * 4. Calls `close()` to shut down the underlying HTTP server.
   *
   * @param timeoutMs — maximum time to wait for in-flight runs to settle.
   *   Defaults to 30 000 ms (30 s).
   */
  drain(timeoutMs?: number): Promise<void>;
}

/**
 * Serve a Hono app on Node.js using `@hono/node-server`.
 * This is an optional convenience; install `@hono/node-server` separately.
 * The core `createServer` return value is runtime-agnostic and works on any
 * Hono-compatible runtime (Cloudflare Workers, Bun, Deno, etc.).
 *
 * Returns a `ServeNodeHandle` with:
 * - `close()` — immediately close the HTTP server.
 * - `drain(timeoutMs?)` — gracefully drain: stop accepting new connections,
 *   return 503 to new `/v1/*` requests, wait for in-flight async runs to settle,
 *   then close. Defaults to 30 s timeout.
 *
 * `opts.hostname` is forwarded to the Node listener. When omitted, the
 * underlying runtime's default bind behavior is preserved.
 */
export async function serveNode(
  app: Hono,
  opts?: { port?: number; hostname?: string },
): Promise<ServeNodeHandle> {
  type NodeHttpServer = {
    close(cb?: () => void): void;
    closeIdleConnections?(): void;
    closeAllConnections?(): void;
  };
  let nodeServer: { serve: (opts: { fetch: (req: Request) => unknown; port: number; hostname?: string }) => NodeHttpServer };
  try {
    nodeServer = await import("@hono/node-server") as typeof nodeServer;
  } catch {
    throw new Error(
      "@hono/node-server is not installed. Run `pnpm add @hono/node-server` (or npm/yarn) in your project to use serveNode().",
    );
  }
  const port = opts?.port ?? 3000;
  const server = nodeServer.serve({
    fetch: app.fetch,
    port,
    ...(opts?.hostname !== undefined ? { hostname: opts.hostname } : {}),
  });

  // Access drain internals injected by createServer (if the app was created via createServer).
  const _setDraining = (app as unknown as { _setDraining?: (v: boolean) => void })._setDraining;
  const _getAsyncRuns = (app as unknown as { _getAsyncRuns?: () => AsyncRunRegistry })._getAsyncRuns;

  return {
    close() {
      server.close();
    },
    async drain(timeoutMs = 30_000): Promise<void> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        throw new Error("drain timeoutMs must be a non-negative safe integer");
      }
      const deadline = Date.now() + timeoutMs;
      // Mark draining so new /v1 requests get 503.
      if (_setDraining) _setDraining(true);

      // Stop accepting new connections immediately; do not wait for active SSE sockets before
      // starting the deadline.
      let closed = false;
      const closePromise = new Promise<void>((resolve) => server.close(() => { closed = true; resolve(); }));
      server.closeIdleConnections?.();

      // Wait for all in-flight async runs to settle, or until timeout.
      while (Date.now() < deadline) {
        if (_getAsyncRuns) {
          const running = _getAsyncRuns().values().filter((e) => e.status === "running");
          if (running.length === 0) break;
        } else {
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, deadline - Date.now()))));
      }

      const running = _getAsyncRuns?.().values().filter((entry) => entry.status === "running") ?? [];
      if (running.length > 0) {
        for (const entry of running) entry.abort?.();
      }

      const remaining = Math.max(0, deadline - Date.now());
      if (!closed && remaining > 0) {
        await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, remaining))]);
      }
      if (!closed) {
        server.closeAllConnections?.();
        await Promise.race([closePromise, new Promise<void>((resolve) => setTimeout(resolve, 25))]);
      }
    },
  };
}
