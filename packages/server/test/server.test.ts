import { describe, it, expect, vi, type SpyInstance } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { createServer, ApiKeyAuth, NoAuth, InMemoryTokenBucketLimiter, InMemoryQuota } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeAgent(responses: ModelResponse[], store?: InMemoryStore) {
  const s = store ?? new InMemoryStore();
  const agent = new Agent({
    id: "test-agent",
    instructions: "You are a helpful assistant.",
    model: new MockModel(responses),
    store: s,
  });
  return { agent, store: s };
}

/** Parse raw SSE body text into an array of parsed event data objects (with optional id). */
function parseSseEvents(body: string): Array<{ event: string; data: unknown; id?: string }> {
  const results: Array<{ event: string; data: unknown; id?: string }> = [];
  const lines = body.split("\n");
  let event = "";
  let data = "";
  let id: string | undefined;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice("id:".length).trim();
    } else if (line === "" && event && data) {
      try {
        results.push({ event, data: JSON.parse(data), id });
      } catch {
        results.push({ event, data, id });
      }
      event = "";
      data = "";
      id = undefined;
    }
  }
  return results;
}

async function readResponseText(res: Response): Promise<string> {
  return await res.text();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 {ok:true} without auth", async () => {
    const app = createServer({ agents: {} });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Query — happy path SSE
// ---------------------------------------------------------------------------

describe("POST /v1/agents/:agentId/query", () => {
  it("streams SSE events and emits a terminal result:success", async () => {
    const { agent } = makeAgent([textResponse("Hello from agent")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "sess-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const text = await readResponseText(res);
    const events = parseSseEvents(text);

    // Should have session.init and result events at minimum
    const types = events.map((e) => e.event);
    expect(types).toContain("session.init");
    expect(types).toContain("result");

    const resultEvent = events.find((e) => e.event === "result");
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("generates a sessionId when not provided", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });

    expect(res.status).toBe(200);
    const text = await readResponseText(res);
    // The SSE comment line carries the generated sessionId
    expect(text).toMatch(/session=/);
  });

  it("returns 404 for unknown agentId", async () => {
    const app = createServer({ agents: {} });
    const res = await app.request("/v1/agents/unknown/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when input is missing", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Auth — ApiKeyAuth
// ---------------------------------------------------------------------------

describe("ApiKeyAuth", () => {
  it("rejects requests with no key (401)", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "secret-key": { userId: "user-1" } }),
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid key (401)", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "secret-key": { userId: "user-1" } }),
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests with a valid key and scopes to the principal's userId", async () => {
    // Two agents sharing one store to validate scope isolation
    const storeA = new InMemoryStore();
    const storeB = new InMemoryStore();
    const agentA = new Agent({
      id: "demo",
      instructions: "A",
      model: new MockModel([textResponse("A-response")]),
      store: storeA,
    });
    const agentB = new Agent({
      id: "demo",
      instructions: "B",
      model: new MockModel([textResponse("B-response")]),
      store: storeB,
    });

    const appA = createServer({
      agents: { demo: agentA },
      auth: ApiKeyAuth({ "key-a": { userId: "alice" } }),
    });
    const appB = createServer({
      agents: { demo: agentB },
      auth: ApiKeyAuth({ "key-b": { userId: "bob" } }),
    });

    const resA = await appA.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-a" },
      body: JSON.stringify({ input: "hello", sessionId: "sess-a" }),
    });
    expect(resA.status).toBe(200);

    const resB = await appB.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-b" },
      body: JSON.stringify({ input: "hello", sessionId: "sess-b" }),
    });
    expect(resB.status).toBe(200);

    // Read both SSE bodies to completion
    await readResponseText(resA);
    await readResponseText(resB);

    // Each store should only have events for its own session
    const eventsA = await storeA.readEvents("sess-a");
    const eventsB = await storeB.readEvents("sess-b");
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    // Cross-contamination check: sess-b should not appear in storeA
    const crossA = await storeA.readEvents("sess-b");
    expect(crossA.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session events endpoint
// ---------------------------------------------------------------------------

describe("GET /v1/agents/:agentId/sessions/:sessionId/events", () => {
  it("returns 404 by default (exposeEvents not set — secure-by-default)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("The answer")], store);
    // No exposeEvents → endpoint must not exist (404).
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request(
      "/v1/agents/demo/sessions/audit-sess/events",
    );
    expect(res.status).toBe(404);
  });

  it("returns the stored events after a query ran (exposeEvents: true)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("The answer")], store);
    const app = createServer({ agents: { demo: agent }, exposeEvents: true });

    // Run a query first
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "what is 2+2?", sessionId: "audit-sess" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes); // drain the stream

    // Now fetch the audit log
    const eventsRes = await app.request(
      "/v1/agents/demo/sessions/audit-sess/events",
    );
    expect(eventsRes.status).toBe(200);
    const body = (await eventsRes.json()) as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown agent (exposeEvents: true)", async () => {
    const app = createServer({ agents: {}, exposeEvents: true });
    const res = await app.request(
      "/v1/agents/unknown/sessions/some-session/events",
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails (exposeEvents: true)", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ key: { userId: "u1" } }),
      exposeEvents: true,
    });
    const res = await app.request(
      "/v1/agents/demo/sessions/s1/events",
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Resume endpoint
// ---------------------------------------------------------------------------

describe("POST /v1/agents/:agentId/resume", () => {
  it("returns 400 when sessionId is missing", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });
    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown agent", async () => {
    const app = createServer({ agents: {} });
    const res = await app.request("/v1/agents/unknown/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(404);
  });

  it("emits an SSE error event (not a 500) when agent.resume throws (non-durable agent)", async () => {
    // A non-durable agent will throw from resume() — the server should
    // catch this and emit a graceful SSE error event rather than crashing.
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "no-such-session" }),
    });
    // The HTTP response is 200 (SSE stream opened); the error is inside the stream.
    expect(res.status).toBe(200);
    const text = await readResponseText(res);
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// AgentResolver function form
// ---------------------------------------------------------------------------

describe("AgentResolver function", () => {
  it("accepts a function resolver and resolves agents correctly", async () => {
    const { agent } = makeAgent([textResponse("resolved!")]);
    const app = createServer({
      agents: (id) => (id === "my-agent" ? agent : undefined),
    });

    const res = await app.request("/v1/agents/my-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(200);

    const notFound = await app.request("/v1/agents/other/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s2" }),
    });
    expect(notFound.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// NoAuth export
// ---------------------------------------------------------------------------

describe("NoAuth", () => {
  it("always allows requests", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent }, auth: NoAuth });
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(200);
  });

  it("requires an explicit override in production", () => {
    const { agent } = makeAgent([textResponse("ok")]);

    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("EIDENTIC_ALLOW_NO_AUTH", "");
      expect(() => createServer({ agents: { demo: agent } })).toThrow(/NoAuth is disabled/);

      vi.stubEnv("EIDENTIC_ALLOW_NO_AUTH", "1");
      expect(() => createServer({ agents: { demo: agent } })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (§20.3)
// ---------------------------------------------------------------------------

describe("Rate limiting", () => {
  it("first request succeeds (200 SSE) with a capacity-1 limiter", async () => {
    // capacity=1, refillPerSec=0 → first request OK, second throttled
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "rl-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    await readResponseText(res); // drain
  });

  it("second request for the same key is throttled — 429 with Retry-After header and error body", async () => {
    // capacity=1, refillPerSec=10 → second request throttled with a finite retryAfterMs
    const { agent } = makeAgent([textResponse("ok"), textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k1": { userId: "u1", apiKey: "k1" } }),
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 10 }),
    });

    const req = (sessionId: string) =>
      app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k1" },
        body: JSON.stringify({ input: "hi", sessionId }),
      });

    const first = await req("rl-a");
    expect(first.status).toBe(200);
    await readResponseText(first); // drain SSE

    const second = await req("rl-b");
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).not.toBeNull();
    const body = (await second.json()) as { error: string; retryAfterMs: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterMs).toBe("number");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("different principal keys are not throttled by each other", async () => {
    // capacity=1 → each key has its own independent bucket
    const { agent: agentA } = makeAgent([textResponse("a1"), textResponse("a2")]);
    const app = createServer({
      agents: { demo: agentA },
      auth: ApiKeyAuth({
        "key-a": { userId: "uA", apiKey: "key-a" },
        "key-b": { userId: "uB", apiKey: "key-b" },
      }),
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
    });

    const resA = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-a" },
      body: JSON.stringify({ input: "hello", sessionId: "iso-a" }),
    });
    expect(resA.status).toBe(200);
    await readResponseText(resA);

    // key-b has its own fresh bucket and should NOT be throttled
    const resB = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-b" },
      body: JSON.stringify({ input: "hello", sessionId: "iso-b" }),
    });
    expect(resB.status).toBe(200);
    await readResponseText(resB);
  });

  it("no-limiter path is byte-identical — existing tests green without rateLimiter configured", async () => {
    // Sanity: a server with no rateLimiter option behaves exactly as before.
    const { agent } = makeAgent([textResponse("fine")]);
    const app = createServer({ agents: { demo: agent } });
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "no-rl" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);
  });

  it("custom rateLimitKey function is used to derive the bucket key", async () => {
    // rateLimitKey always returns "shared-bucket" → all principals share one bucket
    const { agent } = makeAgent([textResponse("ok"), textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "ka": { userId: "uA", apiKey: "ka" },
        "kb": { userId: "uB", apiKey: "kb" },
      }),
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      rateLimitKey: () => "shared-bucket",
    });

    const resA = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer ka" },
      body: JSON.stringify({ input: "hi", sessionId: "ck-a" }),
    });
    expect(resA.status).toBe(200);
    await readResponseText(resA);

    // Different principal but same bucket via custom key → throttled
    const resB = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer kb" },
      body: JSON.stringify({ input: "hi", sessionId: "ck-b" }),
    });
    expect(resB.status).toBe(429);
    await readResponseText(resB);
  });
});

// ---------------------------------------------------------------------------
// Fix 3a — IDOR ownership enforcement
// ---------------------------------------------------------------------------

describe("session ownership (Fix 3a IDOR)", () => {
  /**
   * Make an ApiKeyAuth with two principals:
   *   "key-alice" → userId: "alice"
   *   "key-bob"   → userId: "bob"
   */
  function makeOwnershipApp(responses: ModelResponse[]) {
    const { agent, store } = makeAgent(responses);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-alice": { userId: "alice" },
        "key-bob": { userId: "bob" },
      }),
      exposeEvents: true,
    });
    return { app, agent, store };
  }

  it("query: principal A creates a session owned by A", async () => {
    const { app, store } = makeOwnershipApp([textResponse("hello")]);

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "owner-sess-alice" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    const session = await store.getSession("owner-sess-alice");
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("alice");
  });

  it("resume: principal B gets 403 on a session owned by principal A", async () => {
    const { app } = makeOwnershipApp([textResponse("hello"), textResponse("resumed")]);

    // Alice creates the session
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "idor-sess-1" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    // Bob tries to resume Alice's session → 403
    const resumeRes = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-bob" },
      body: JSON.stringify({ sessionId: "idor-sess-1" }),
    });
    expect(resumeRes.status).toBe(403);
  });

  it("events: principal B gets 403 on a session owned by principal A", async () => {
    const { app } = makeOwnershipApp([textResponse("hello")]);

    // Alice creates the session
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "idor-events-1" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    // Bob tries to read Alice's events → 403
    const eventsRes = await app.request("/v1/agents/demo/sessions/idor-events-1/events", {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(eventsRes.status).toBe(403);
  });

  it("events: principal A can read their own session's events", async () => {
    const { app } = makeOwnershipApp([textResponse("hello")]);

    // Alice creates the session
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "idor-events-alice" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    // Alice reads her own events → 200
    const eventsRes = await app.request("/v1/agents/demo/sessions/idor-events-alice/events", {
      headers: { authorization: "Bearer key-alice" },
    });
    expect(eventsRes.status).toBe(200);
    const body = await eventsRes.json();
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("events: no-owner legacy session is denied when authentication is configured", async () => {
    // Create a session directly in the store without a userId (simulates a pre-Fix-1 legacy session)
    const { app, store } = makeOwnershipApp([]);
    await store.migrate();
    await store.createSession({ id: "legacy-sess", agentId: "demo", createdAt: new Date().toISOString() });

    // Authenticated multi-tenant mode must fail closed for ownerless legacy data.
    const eventsRes = await app.request("/v1/agents/demo/sessions/legacy-sess/events", {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(eventsRes.status).toBe(403);
  });

  it("events: ownerless legacy access requires an explicit compatibility opt-in", async () => {
    const { agent, store } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "key-bob": { userId: "bob" } }),
      exposeEvents: true,
      allowLegacyUnownedRecords: true,
    });
    await store.migrate();
    await store.createSession({ id: "legacy-opt-in", agentId: "demo", createdAt: new Date().toISOString() });

    const eventsRes = await app.request("/v1/agents/demo/sessions/legacy-opt-in/events", {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(eventsRes.status).toBe(200);
  });

  it("events: matching org does not authorize a different user-owned session", async () => {
    const { agent } = makeAgent([textResponse("hello")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-alice": { userId: "alice", orgId: "acme" },
        "key-bob": { userId: "bob", orgId: "acme" },
      }),
      exposeEvents: true,
    });

    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "same-org-user-owned" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    const eventsRes = await app.request("/v1/agents/demo/sessions/same-org-user-owned/events", {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(eventsRes.status).toBe(403);
  });

  // Finding #1 — IDOR on /query: cross-session read via client-supplied sessionId
  it("query: principal B gets 403 when passing a sessionId owned by principal A (Finding #1)", async () => {
    const { app } = makeOwnershipApp([textResponse("hello"), textResponse("intruder")]);

    // Alice creates the session via /query
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "alice-private-session" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    // Bob passes Alice's sessionId to /query → must be rejected with 403
    const attackRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-bob" },
      body: JSON.stringify({ input: "read alice context", sessionId: "alice-private-session" }),
    });
    expect(attackRes.status).toBe(403);
    await readResponseText(attackRes);
  });

  it("query: principal A can re-use their own sessionId on /query (not accidentally blocked)", async () => {
    const { app } = makeOwnershipApp([textResponse("first"), textResponse("second")]);

    // Alice creates the session
    const first = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "turn 1", sessionId: "alice-own-sess" }),
    });
    expect(first.status).toBe(200);
    await readResponseText(first);

    // Alice continues the conversation with the same sessionId → 200
    const second = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "turn 2", sessionId: "alice-own-sess" }),
    });
    expect(second.status).toBe(200);
    await readResponseText(second);
  });
});

// ---------------------------------------------------------------------------
// Finding #4 — Quota reservation released on early return paths (400/404)
// ---------------------------------------------------------------------------

describe("Quota reservation not leaked on early return paths (Finding #4)", () => {
  function makeQuotaApp(responses: ModelResponse[]) {
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "test-agent",
      instructions: "You are a helpful assistant.",
      model: new MockModel(responses),
      store,
    });
    const quota = new InMemoryQuota({ hardRuns: 3 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });
    return { app, quota };
  }

  it("/query: 400 on missing input does not consume quota capacity", async () => {
    const { app, quota } = makeQuotaApp([]);

    // Invalid request (missing input) → 400
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);

    // Quota ledger must show 0 runs consumed and 0 in-flight reservations.
    // Capacity still available.
    const r1 = quota.check("k");
    expect(r1.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((r1 as any).reservation!);
    expect(r1.usage?.runs).toBe(0);
  });

  it("/query: 404 on unknown agent does not consume quota capacity", async () => {
    const { app, quota } = makeQuotaApp([]);

    // Unknown agent → 404
    const res = await app.request("/v1/agents/unknown-agent/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);

    // Capacity still available — in-flight counter must not have been incremented.
    const r1 = quota.check("k");
    expect(r1.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((r1 as any).reservation!);
    expect(r1.usage?.runs).toBe(0);
  });

  it("/resume: 400 on missing sessionId does not consume quota capacity", async () => {
    const { app, quota } = makeQuotaApp([]);

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const r1 = quota.check("k");
    expect(r1.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((r1 as any).reservation!);
    expect(r1.usage?.runs).toBe(0);
  });

  it("/resume: 404 on unknown agent does not consume quota capacity", async () => {
    const { app, quota } = makeQuotaApp([]);

    const res = await app.request("/v1/agents/unknown-agent/resume", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(404);

    const r1 = quota.check("k");
    expect(r1.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((r1 as any).reservation!);
    expect(r1.usage?.runs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SSE stream resumability
// ---------------------------------------------------------------------------

describe("SSE stream resumability (Last-Event-ID)", () => {
  /**
   * Run a query and collect the raw SSE body text.
   */
  async function runQuery(
    app: ReturnType<typeof createServer>,
    sessionId: string,
    input = "hello",
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({ input, sessionId }),
    });
    expect(res.status).toBe(200);
    return readResponseText(res);
  }

  it("fresh connection: all events carry an SSE id field", async () => {
    const { agent } = makeAgent([textResponse("hi there")]);
    const app = createServer({ agents: { demo: agent } });

    const text = await runQuery(app, "sse-id-sess-1");
    const events = parseSseEvents(text);

    // Every event except stream.delta and result should have an id
    const sessionInitEvents = events.filter((e) => e.event === "session.init");
    expect(sessionInitEvents.length).toBeGreaterThan(0);
    expect(sessionInitEvents[0]!.id).toBeDefined();
    expect(sessionInitEvents[0]!.id).toMatch(/^\d+$/);

    const assistantEvents = events.filter((e) => e.event === "assistant");
    expect(assistantEvents.length).toBeGreaterThan(0);
    expect(assistantEvents[0]!.id).toBeDefined();
    expect(assistantEvents[0]!.id).toMatch(/^\d+$/);
  });

  it("fresh connection: stream.delta events do NOT carry an SSE id", async () => {
    // MockModel does not emit stream.delta; just verify result has no id
    const { agent } = makeAgent([textResponse("hi")]);
    const app = createServer({ agents: { demo: agent } });

    const text = await runQuery(app, "sse-id-delta-sess");
    const events = parseSseEvents(text);

    // result event should have no id
    const resultEvents = events.filter((e) => e.event === "result");
    expect(resultEvents.length).toBeGreaterThan(0);
    expect(resultEvents[0]!.id).toBeUndefined();
  });

  it("fresh connection: SSE ids are monotonically increasing for persisted events", async () => {
    const { agent } = makeAgent([
      // Two-turn interaction: first response has a tool call, second is final
      {
        content: [{ type: "tool_use", callId: "c1", name: "unknown_tool", input: {} }],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
      textResponse("done"),
    ]);
    const app = createServer({ agents: { demo: agent } });

    const text = await runQuery(app, "sse-id-mono-sess");
    const events = parseSseEvents(text);

    // Collect ids from events that have them
    const idsWithValues = events
      .filter((e) => e.id !== undefined)
      .map((e) => parseInt(e.id!, 10));

    // ids must be non-decreasing (monotonic)
    for (let i = 1; i < idsWithValues.length; i++) {
      expect(idsWithValues[i]!).toBeGreaterThanOrEqual(idsWithValues[i - 1]!);
    }
  });

  it("no Last-Event-ID: response is byte-compatible with previous behaviour", async () => {
    // Ensure the old path still works — no regressions
    const { agent } = makeAgent([textResponse("compat-check")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "compat-sess" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await readResponseText(res);
    const events = parseSseEvents(text);
    const types = events.map((e) => e.event);
    expect(types).toContain("session.init");
    expect(types).toContain("result");
    const resultEvent = events.find((e) => e.event === "result");
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("reconnect with Last-Event-ID: only receives events with seq > N (replay)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("from store replay")], store);
    const app = createServer({ agents: { demo: agent } });

    // First: run a query to completion so events are stored
    await runQuery(app, "replay-sess-1");

    // Read stored events to understand what's in the log
    const stored = await store.readEvents("replay-sess-1");
    expect(stored.length).toBeGreaterThan(0);

    // Reconnect with Last-Event-ID=0 — replays all events with seq > 0 (assistant etc.)
    const reconnectText = await runQuery(app, "replay-sess-1", "hello", {
      "last-event-id": "0",
    });
    const reconnectEvents = parseSseEvents(reconnectText);

    // Should receive assistant events and a synthesized result (no new query started)
    const types = reconnectEvents.map((e) => e.event);
    expect(types).toContain("result");
    const resultEvent = reconnectEvents.find((e) => e.event === "result");
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("reconnect with Last-Event-ID equal to last stored seq: receives only result (nothing to replay)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("short response")], store);
    const app = createServer({ agents: { demo: agent } });

    // Run query to completion
    await runQuery(app, "replay-sess-2");

    // Get the seq of the last stored event
    const stored = await store.readEvents("replay-sess-2");
    const lastSeq = stored[stored.length - 1]!.seq;

    // Reconnect with Last-Event-ID = lastSeq (already received all stored events)
    const reconnectText = await runQuery(app, "replay-sess-2", "hello", {
      "last-event-id": String(lastSeq),
    });
    const reconnectEvents = parseSseEvents(reconnectText);

    // Should only receive the synthesized result (no stored events to replay)
    const assistantEvents = reconnectEvents.filter((e) => e.event === "assistant");
    expect(assistantEvents.length).toBe(0); // nothing to replay

    const resultEvent = reconnectEvents.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("replay: replayed events carry the correct stored seq as their SSE id", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("replay-id-check")], store);
    const app = createServer({ agents: { demo: agent } });

    // Run query to completion
    await runQuery(app, "replay-id-sess");

    // Get stored events
    const stored = await store.readEvents("replay-id-sess");
    const assistantStoredEvents = stored.filter((e) => e.kind === "assistant");
    expect(assistantStoredEvents.length).toBeGreaterThan(0);

    // Reconnect from near the beginning (replay events with seq > 0)
    const reconnectText = await runQuery(app, "replay-id-sess", "hello", {
      "last-event-id": "0",
    });
    const reconnectEvents = parseSseEvents(reconnectText);

    // Replayed assistant events should have ids matching stored seq values
    const replayedAssistantEvents = reconnectEvents.filter((e) => e.event === "assistant");
    for (const replayedEv of replayedAssistantEvents) {
      expect(replayedEv.id).toBeDefined();
      const replayedSeq = parseInt(replayedEv.id!, 10);
      const matchingStored = assistantStoredEvents.find((s) => s.seq === replayedSeq);
      expect(matchingStored).toBeDefined();
    }
  });

  it("ownership enforced on reconnect: wrong principal gets 403 even with Last-Event-ID", async () => {
    const { agent } = makeAgent([textResponse("alice's data"), textResponse("more")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-alice": { userId: "alice" },
        "key-bob": { userId: "bob" },
      }),
    });

    // Alice creates the session
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "sse-ownership-sess" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    // Bob tries to reconnect with Last-Event-ID on Alice's session
    const attackRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer key-bob",
        "last-event-id": "0",
      },
      body: JSON.stringify({ input: "hi", sessionId: "sse-ownership-sess" }),
    });
    // Ownership check runs before Last-Event-ID replay — must be rejected
    expect(attackRes.status).toBe(403);
  });

  it("reconnect with Last-Event-ID on /resume route: replays stored events", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("resume-replay-result")], store);
    const app = createServer({ agents: { demo: agent } });

    // First run a /query to build up the session
    await runQuery(app, "resume-replay-sess");

    const stored = await store.readEvents("resume-replay-sess");
    expect(stored.length).toBeGreaterThan(0);

    // Reconnect via /resume with Last-Event-ID=0 (replay events with seq > 0)
    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "last-event-id": "0",
      },
      body: JSON.stringify({ sessionId: "resume-replay-sess" }),
    });
    expect(res.status).toBe(200);
    const text = await readResponseText(res);
    const events = parseSseEvents(text);

    // Should get a result event (either replayed result or synthesized)
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("reconnect /query with Last-Event-ID on empty session: readEvents called exactly once (no double DB read)", async () => {
    // Regression test for Fix 2: when a client reconnects with Last-Event-ID and
    // no stored events exist (in-progress / fresh session), the server falls through
    // to live streaming. The live path must reuse the already-loaded storedEvents
    // for baseSeq rather than calling readEvents a second time.
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("single-read-result")], store);
    const app = createServer({ agents: { demo: agent } });

    // Spy on readEvents before the request so we capture all calls.
    const readEventsSpy = vi.spyOn(store, "readEvents");

    // Send query with last-event-id on a session that has no stored events.
    // isResume=true → replay path (empty, falls through) → live streaming path.
    // If the code has the double-read bug, readEvents is called twice.
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "0" },
      body: JSON.stringify({ input: "hello", sessionId: "single-read-sess" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    // readEvents should be called exactly twice:
    //   1. once by the replay path (isResume block)
    //   2. once by the agent loop internally (to reconstruct conversation context)
    // NOT three times — the live streaming path must reuse the storedEvents loaded
    // in the replay block rather than issuing a redundant second store read.
    expect(readEventsSpy).toHaveBeenCalledTimes(2);
    readEventsSpy.mockRestore();
  });

  it("reconnect /resume with Last-Event-ID on empty session: readEvents called exactly once (no double DB read)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("resume-single-read")], store);
    const app = createServer({ agents: { demo: agent } });

    // Spy on readEvents before the request.
    const readEventsSpy = vi.spyOn(store, "readEvents");

    // Reconnect via /resume with Last-Event-ID on a session with no stored events.
    // Triggers the in-progress fall-through: replay (nothing) → live streaming.
    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "0" },
      body: JSON.stringify({ sessionId: "resume-single-read-sess" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    // readEvents should be called exactly once.
    expect(readEventsSpy).toHaveBeenCalledTimes(1);
    readEventsSpy.mockRestore();
  });

  it("reconnect with Last-Event-ID ownership enforced on /resume route", async () => {
    const { agent } = makeAgent([textResponse("secure-resume"), textResponse("extra")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-alice": { userId: "alice" },
        "key-bob": { userId: "bob" },
      }),
    });

    // Alice creates the session via /query
    const queryRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "hi", sessionId: "resume-idor-sess" }),
    });
    expect(queryRes.status).toBe(200);
    await readResponseText(queryRes);

    // Bob tries to reconnect via /resume with Last-Event-ID on Alice's session
    const attackRes = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer key-bob",
        "last-event-id": "0",
      },
      body: JSON.stringify({ sessionId: "resume-idor-sess" }),
    });
    expect(attackRes.status).toBe(403);
  });
});
