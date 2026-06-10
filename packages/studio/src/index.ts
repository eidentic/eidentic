/**
 * @eidentic/studio — agent/session/memory/skills management API.
 *
 * SECURITY WARNING: `auth` defaults to NoAuth. This package is designed as a
 * LOCAL DEV TOOL. Do NOT expose the studio API on a public network without
 * configuring an `AuthPort` (e.g. ApiKeyAuth). Any unauthenticated caller would
 * have full read/write access to agent memory and session data.
 */

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Agent } from "@eidentic/core";
import type { AuthPort, AuthRequest, Scope, StoredEvent, PriceTable } from "@eidentic/types";
import type { StepTrace, WorkflowResult } from "@eidentic/workflow";
import { createWorkflowRunRegistry } from "@eidentic/workflow";
import { createServer, NoAuth, ApiKeyAuth, serveNode } from "@eidentic/server";
import { defaultPrices, pricesUpdatedAt } from "@eidentic/model";
export { NoAuth, ApiKeyAuth, serveNode };
export type { ServeNodeHandle } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A SkillBank-shaped interface: only what the studio needs. */
interface SkillBankLike {
  list(): unknown[];
  approve(name: string): boolean;
}

/** Summary shape returned by GET /api/workflows (list). */
export interface WorkflowRunSummary {
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  stepCount: number;
}

/**
 * The Hono app returned by createStudioApi / createStudio, extended with
 * workflow recording. It IS a Hono instance (all `app.request(...)` etc. work)
 * and additionally exposes `recordWorkflow`.
 */
export type StudioHandle = Hono & {
  /**
   * Record a completed workflow run into the in-memory registry.
   *
   * @param name   - Human-readable workflow name (e.g. "triage").
   * @param result - The WorkflowResult returned by `workflow.run()`.
   *
   * @example
   * const r = await wf.run(input);
   * studio.recordWorkflow("triage", r);
   */
  recordWorkflow<O>(name: string, result: WorkflowResult<O>): void;
};

export interface StudioOptions {
  /** The agents to inspect/manage, keyed by their id. */
  agents: Record<string, Agent>;
  /**
   * Optional skill banks, keyed by agentId. Each value must be a SkillBank
   * (from @eidentic/skills) or any object with a `list()` and `approve()` method.
   */
  skillBanks?: Record<string, SkillBankLike>;
  /**
   * Authentication adapter. Defaults to NoAuth.
   *
   * IMPORTANT: The studio exposes agent memory read/write, session traces,
   * and fact graph data. In production or any networked environment, always
   * configure ApiKeyAuth (or a custom AuthPort) — never run with NoAuth
   * on an internet-reachable address.
   */
  auth?: AuthPort;
  /** Base path for the management API. Default "/api". */
  basePath?: string;
  /**
   * USD price table used for cost estimation. Defaults to `defaultPrices` from
   * @eidentic/model. Pass a custom table to override (e.g. for private deployments
   * with negotiated pricing). Token counts are always exact; USD is an estimate.
   */
  prices?: PriceTable;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runAuth(auth: AuthPort, req: Request): Promise<boolean> {
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
  const principal = await auth.authenticate(authReq);
  return principal !== null;
}

function hasGraph(store: unknown): store is {
  queryFacts(q: {
    scope: Scope;
    subject?: string;
    predicate?: string;
    object?: string;
    validAt?: string;
    includeInvalidated?: boolean;
    limit?: number;
  }): Promise<unknown[]>;
} {
  return typeof (store as Record<string, unknown>)["queryFacts"] === "function";
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

// ---------------------------------------------------------------------------
// Cost / usage helpers
// ---------------------------------------------------------------------------

interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  messages: number;
}

/**
 * Sum meta.usage across all events in a session. Only `assistant` events carry
 * usage; each such event also counts as one message. Defensive: missing meta/usage
 * fields are treated as zero.
 */
function sessionUsage(events: StoredEvent[]): SessionUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let messages = 0;
  for (const e of events) {
    if (e.kind !== "assistant") continue;
    messages++;
    const usage = (e.meta as Record<string, unknown> | null | undefined)?.["usage"] as
      | { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
      | null
      | undefined;
    if (!usage) continue;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
  }
  return { inputTokens, outputTokens, cachedInputTokens, messages };
}

/**
 * Compute USD cost for a usage summary against a price table entry.
 * Mirrors the `usdFor` formula in packages/core/src/loop.ts (cached-input split):
 *   cachedToks = min(cachedInputTokens, inputTokens)
 *   uncachedToks = inputTokens - cachedToks
 *   cacheRate = p.cachedInputPerMTok ?? p.inputPerMTok
 *   usd = (uncachedToks * inputPerMTok + cachedToks * cacheRate + outputTokens * outputPerMTok) / 1_000_000
 * Keep this in sync with loop.ts usdFor when pricing logic changes.
 */
function usdForUsage(
  usage: SessionUsageSummary,
  prices: PriceTable,
  modelId: string | undefined,
): number | undefined {
  if (!modelId) return undefined;
  const p = prices[modelId];
  if (!p) return undefined;
  const cachedToks = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedToks = usage.inputTokens - cachedToks;
  const cacheRate = p.cachedInputPerMTok ?? p.inputPerMTok;
  return (
    uncachedToks * p.inputPerMTok +
    cachedToks * cacheRate +
    usage.outputTokens * p.outputPerMTok
  ) / 1_000_000;
}

// ---------------------------------------------------------------------------
// createStudioApi
// ---------------------------------------------------------------------------

/**
 * Build a Hono app exposing the Eidentic Studio management API.
 *
 * Routes (all JSON, auth-gated except health):
 *   GET    /api/health
 *   GET    /api/agents
 *   GET    /api/agents/:id/sessions?limit=
 *   GET    /api/agents/:id/sessions/:sid/events
 *   GET    /api/agents/:id/blocks?userId=
 *   PUT    /api/agents/:id/blocks/:label
 *   GET    /api/agents/:id/facts?userId=&subject=
 *   GET    /api/agents/:id/memories?userId=&q=
 *   GET    /api/agents/:id/skills
 *   POST   /api/agents/:id/skills/:skillId/approve
 *   GET    /api/workflows
 *   GET    /api/workflows/:id
 *   POST   /api/workflows  (HTTP ingestion, auth-gated)
 *
 * Returns a StudioHandle with `app` (the Hono instance) and `recordWorkflow`.
 */
export function createStudioApi(opts: StudioOptions): StudioHandle {
  const auth = opts.auth ?? NoAuth;
  const base = (opts.basePath ?? "/api").replace(/\/$/, "");
  const app = new Hono({ strict: false });

  // Workflow registry (shared mutable state for this studio instance).
  const wfRegistry = createWorkflowRunRegistry({ limit: 100 });

  // --- Health (no auth) ---
  app.get(`${base}/health`, (c) => c.json({ ok: true }));

  // --- Auth middleware for all routes under base (excluding /health) ---
  app.use(`${base}/*`, async (c, next) => {
    // Health is already handled above and will 404 here if it ever reaches this middleware,
    // but we guard anyway so a /health request isn't blocked by auth.
    if (c.req.path === `${base}/health`) {
      return next();
    }
    const ok = await runAuth(auth, c.req.raw);
    if (!ok) return c.json({ error: "Unauthorized" }, 401);
    return next();
  });

  // --- Agents list ---
  app.get(`${base}/agents`, (c) => {
    const agents = Object.entries(opts.agents).map(([id, agent]) => {
      const store = agent.store;
      const hasMemory = typeof (store as unknown as Record<string, unknown>)["getBlocks"] === "function";
      const hasSkills = opts.skillBanks?.[id] !== undefined || agent.skillCatalog().length > 0;
      const hasGraphFeature = hasGraph(store);
      // Never leak model keys, API keys, instructions, or any other config.
      return {
        id,
        hasMemory,
        hasSkills,
        hasGraph: hasGraphFeature,
        toolCount: agent.toolSchemas().length,
      };
    });
    return c.json(agents);
  });

  // --- Agent detail ---
  app.get(`${base}/agents/:id`, (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const store = agent.store;
    const hasMemory = typeof (store as unknown as Record<string, unknown>)["getBlocks"] === "function";
    const hasSkillsFlag = opts.skillBanks?.[id] !== undefined || agent.skillCatalog().length > 0;
    const hasGraphFeature = hasGraph(store);
    return c.json({
      id,
      instructions: agent.instructions,
      model: agent.modelId,
      tools: agent.toolSchemas(),
      hasMemory,
      hasSkills: hasSkillsFlag,
      hasGraph: hasGraphFeature,
    });
  });

  // --- Sessions list (with per-session usage + usd) ---
  app.get(`${base}/agents/:id/sessions`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const limit = parseLimit(c.req.query("limit"));
    const sessions = await agent.store.listSessions({ agentId: id, limit });
    const priceTable = opts.prices ?? defaultPrices;
    const modelId = agent.modelId;
    // Enrich each session with usage totals (read its events, sum meta.usage).
    // For v1 this computes per listed session; the list is already capped by `limit`.
    const enriched = await Promise.all(
      sessions.map(async (s) => {
        try {
          const events = await agent.store.readEvents(s.id);
          const usage = sessionUsage(events as StoredEvent[]);
          const usd = usdForUsage(usage, priceTable, modelId);
          return { ...s, usage, usd };
        } catch {
          // Non-fatal: if events can't be read, return session without usage.
          return s;
        }
      }),
    );
    return c.json(enriched);
  });

  // --- Session events (trace) ---
  app.get(`${base}/agents/:id/sessions/:sid/events`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const sid = c.req.param("sid");
    const events = await agent.store.readEvents(sid);
    return c.json({ events });
  });

  // --- Per-agent cost aggregate ---
  app.get(`${base}/agents/:id/cost`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const priceTable = opts.prices ?? defaultPrices;
    const pricedFrom: "default" | "configured" = opts.prices ? "configured" : "default";
    const modelId = agent.modelId;

    // List all sessions for this agent (no limit for aggregate).
    const sessions = await agent.store.listSessions({ agentId: id });
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;
    let totalMessages = 0;
    let totalUsd = 0;
    let hasUsd = false;

    for (const s of sessions) {
      try {
        const events = await agent.store.readEvents(s.id);
        const usage = sessionUsage(events as StoredEvent[]);
        totalInput += usage.inputTokens;
        totalOutput += usage.outputTokens;
        totalCached += usage.cachedInputTokens;
        totalMessages += usage.messages;
        const usd = usdForUsage(usage, priceTable, modelId);
        if (usd !== undefined) {
          totalUsd += usd;
          hasUsd = true;
        }
      } catch {
        // Non-fatal: skip sessions whose events can't be read.
      }
    }

    return c.json({
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedInputTokens: totalCached,
      usd: hasUsd ? totalUsd : undefined,
      messages: totalMessages,
      sessions: sessions.length,
      modelId: modelId ?? null,
      pricedFrom,
      pricesUpdatedAt,
    });
  });

  // --- Blocks list ---
  app.get(`${base}/agents/:id/blocks`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const userId = c.req.query("userId");
    const scope: Scope = userId
      ? { kind: "user", agentId: id, userId }
      : { kind: "agent", agentId: id };
    const blocks = await agent.store.listBlocks(scope);
    return c.json(blocks);
  });

  // --- Block upsert (CAS) ---
  app.put(`${base}/agents/:id/blocks/:label`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const label = c.req.param("label");
    const userId = c.req.query("userId");
    const scope: Scope = userId
      ? { kind: "user", agentId: id, userId }
      : { kind: "agent", agentId: id };

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const { value, expectVersion } = body as { value?: unknown; expectVersion?: unknown };
    if (typeof value !== "string") {
      return c.json({ error: "Missing or invalid 'value' field (string required)" }, 400);
    }
    if (expectVersion !== undefined && typeof expectVersion !== "number") {
      return c.json({ error: "'expectVersion' must be a number when provided" }, 400);
    }

    try {
      const block = await agent.store.upsertBlock(
        scope,
        { label, value },
        typeof expectVersion === "number" ? expectVersion : undefined,
      );
      return c.json(block);
    } catch (err: unknown) {
      if (err instanceof Error && /conflict/i.test(err.message)) {
        return c.json({ error: "conflict", message: err.message }, 409);
      }
      throw err;
    }
  });

  // --- Facts ---
  app.get(`${base}/agents/:id/facts`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const userId = c.req.query("userId");
    const subject = c.req.query("subject");
    const scope: Scope = userId
      ? { kind: "user", agentId: id, userId }
      : { kind: "agent", agentId: id };
    if (!hasGraph(agent.store)) {
      return c.json([]);
    }
    const facts = await agent.store.queryFacts({ scope, ...(subject ? { subject } : {}) });
    return c.json(facts);
  });

  // --- Memories search ---
  app.get(`${base}/agents/:id/memories`, async (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const userId = c.req.query("userId");
    const q = c.req.query("q") ?? "";
    const scope: Scope = userId
      ? { kind: "user", agentId: id, userId }
      : { kind: "agent", agentId: id };
    const snippets = await agent.store.searchMemory(scope, q, 20);
    return c.json(snippets);
  });

  // --- Skills list (unified: prompt catalog + executable bank) ---
  app.get(`${base}/agents/:id/skills`, (c) => {
    const id = c.req.param("id");
    const agent = opts.agents[id];
    if (!agent) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const promptSkills = agent.skillCatalog().map((s) => ({
      name: s.name,
      description: s.description,
      type: "prompt" as const,
    }));
    const bank = opts.skillBanks?.[id];
    const bankSkills = (bank ? bank.list() : []).map((rawLock) => {
      const lock = rawLock as Record<string, unknown>;
      return {
        name: (lock["name"] as string | undefined) ?? (lock["skillId"] as string | undefined) ?? "?",
        description: (lock["description"] as string | undefined) ?? "",
        type: "executable" as const,
        quarantined: !!(lock["quarantined"]),
        version: lock["version"] as number | undefined,
        author: lock["author"] as string | undefined,
      };
    });
    return c.json([...promptSkills, ...bankSkills]);
  });

  // --- Skills approve ---
  app.post(`${base}/agents/:id/skills/:skillId/approve`, (c) => {
    const id = c.req.param("id");
    if (!opts.agents[id]) return c.json({ error: `Unknown agent: ${id}` }, 404);
    const bank = opts.skillBanks?.[id];
    if (!bank) return c.json({ error: "No skill bank configured for this agent" }, 404);
    const skillId = c.req.param("skillId");
    const ok = bank.approve(skillId);
    if (!ok) return c.json({ error: `Skill not found: ${skillId}` }, 404);
    return c.json({ approved: true, name: skillId });
  });

  // --- Workflow runs — list ---
  app.get(`${base}/workflows`, (c) => {
    const runs = wfRegistry.list();
    const summaries: WorkflowRunSummary[] = runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      stepCount: r.stepCount,
    }));
    return c.json(summaries);
  });

  // --- Workflow runs — detail ---
  app.get(`${base}/workflows/:wid`, (c) => {
    const wid = c.req.param("wid");
    const run = wfRegistry.get(wid);
    if (!run) return c.json({ error: `Unknown workflow run: ${wid}` }, 404);
    return c.json(run);
  });

  // --- Workflow runs — HTTP ingestion (POST) ---
  app.post(`${base}/workflows`, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }
    const b = body as Record<string, unknown>;
    const name = b["name"];
    if (typeof name !== "string" || !name) {
      return c.json({ error: "Missing or invalid 'name' field (non-empty string required)" }, 400);
    }
    const trace = b["trace"];
    if (!Array.isArray(trace)) {
      return c.json({ error: "Missing or invalid 'trace' field (array required)" }, 400);
    }
    const result: WorkflowResult<unknown> = {
      output: b["output"],
      trace: trace as StepTrace[],
    };
    const record = wfRegistry.record(name, result);
    return c.json({ id: record.id, name: record.name, status: record.status }, 201);
  });

  // Attach recordWorkflow directly to the Hono app object so existing callers
  // can still do `app.request(...)` while new callers get `app.recordWorkflow(...)`.
  const handle = app as StudioHandle;
  handle.recordWorkflow = function recordWorkflow<O>(name: string, result: WorkflowResult<O>): void {
    wfRegistry.record(name, result);
  };

  return handle;
}

// ---------------------------------------------------------------------------
// createStudio — combines createServer (run routes) + studio management routes
// ---------------------------------------------------------------------------

/**
 * Build a Hono app combining the agent query/resume/events run API (from
 * `@eidentic/server`) with the Studio management API.
 *
 * Run routes:  POST /v1/agents/:id/query   (SSE)
 *              POST /v1/agents/:id/resume  (SSE)
 * Studio:      GET  /api/health
 *              GET  /api/agents
 *              ...all management routes
 *
 * Returns a StudioHandle (includes `recordWorkflow` and `app`).
 */
export function createStudio(opts: StudioOptions): StudioHandle {
  const run = createServer({
    agents: opts.agents,
    auth: opts.auth,
    exposeEvents: true,
  });
  const studioHandle = createStudioApi(opts);

  const combined = new Hono({ strict: false });
  combined.route("/", run);
  combined.route("/", studioHandle);

  // Attach the same recordWorkflow to the combined app so callers can use it.
  const handle = combined as StudioHandle;
  handle.recordWorkflow = studioHandle.recordWorkflow.bind(studioHandle);
  return handle;
}

// ---------------------------------------------------------------------------
// serveStudio — static SPA + API combined server
// ---------------------------------------------------------------------------

export interface StudioServeOptions extends StudioOptions {}

/**
 * Build the combined Hono app (static SPA + /api + /v1 routes) and serve it
 * via @hono/node-server on the given port.
 *
 * The built React SPA (ui/dist) is resolved relative to this source file at
 * runtime so it works whether installed from npm or used from the monorepo.
 */
export async function serveStudio(
  opts: StudioServeOptions,
  { port = 3535 }: { port?: number } = {},
): Promise<import("@eidentic/server").ServeNodeHandle> {
  // Resolve ui/dist relative to this module file.
  // import.meta.url works in ESM; in CJS contexts (rare for a dev-tool server)
  // we fall back to __dirname if it exists in scope.
  let uiDist: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metaUrl: string | undefined = (import.meta as any).url as string | undefined;
  if (metaUrl) {
    const _dirname = dirname(fileURLToPath(metaUrl));
    // Built layout: dist/index.js → go up one level and into ui/dist
    uiDist = join(_dirname, "..", "ui", "dist");
  } else {
    // CJS fallback: __dirname is available in CommonJS context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cjsDirname: string = (typeof __dirname !== "undefined" ? __dirname : process.cwd()) as string;
    uiDist = join(cjsDirname, "..", "ui", "dist");
  }

  const handle = createStudio(opts);

  // Serve static assets from ui/dist. Hono's serveStatic for Node reads from
  // the filesystem using a `root` resolved against process.cwd() by default,
  // so we use rewriteRequestPath to strip any prefix and set root to uiDist.
  handle.use(
    "/*",
    serveStatic({
      root: uiDist,
      rewriteRequestPath: (path) => {
        // Strip leading slash so serveStatic resolves against root directly.
        return path === "/" ? "/index.html" : path;
      },
    }),
  );

  // SPA fallback: any unmatched path → index.html
  handle.get("/*", serveStatic({ root: uiDist, path: "/index.html" }));

  return serveNode(handle, { port });
}
