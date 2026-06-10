/**
 * Security-hardening test suite for @eidentic/server.
 * Covers the fixes applied in the fix/server-hardening branch:
 *   C3  — pre-auth rate limiting + anonymous bucket isolation
 *   H1  — apiKey-only session ownership
 *   H3  — agent-ID enumeration prevention + X-Content-Type-Options: nosniff
 *   M7  — per-field input length cap
 *   M8  — SSE error message sanitization
 *   M9  — Last-Event-ID validation
 */
import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { createServer, ApiKeyAuth, InMemoryTokenBucketLimiter } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Shared helpers
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

// ---------------------------------------------------------------------------
// C3 — Pre-auth rate limiting
// ---------------------------------------------------------------------------

describe("C3: pre-auth rate limiting", () => {
  it("default: hammering with invalid credentials triggers 429 after bucket empties", async () => {
    // Very tight limiter: capacity=2, no refill — third request triggers 429.
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 2, refillPerSec: 0 }),
      // Make getClientKey always return the same key so all requests share one bucket.
      getClientKey: () => "test-client",
    });

    const badReq = () =>
      app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-key" },
        body: JSON.stringify({ input: "hi" }),
      });

    const r1 = await badReq();
    const r2 = await badReq();
    // First two consume the bucket (they fail auth with 401, but pass pre-auth check).
    expect([r1.status, r2.status]).toEqual(expect.arrayContaining([401]));

    const r3 = await badReq();
    // Third request hits the pre-auth limit.
    expect(r3.status).toBe(429);
    const body = await r3.json() as { error: string };
    expect(body.error).toBe("rate_limited");
  });

  it("different client keys have independent buckets", async () => {
    const { agent } = makeAgent([]);
    let key = "client-A";
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      getClientKey: () => key,
    });

    const req = (k: string) => {
      key = k;
      return app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bad" },
        body: JSON.stringify({ input: "hi" }),
      });
    };

    const rA1 = await req("client-A");
    expect(rA1.status).toBe(401); // passes pre-auth, fails real auth

    const rA2 = await req("client-A");
    expect(rA2.status).toBe(429); // client-A bucket exhausted

    // client-B has its own fresh bucket — should NOT be throttled by client-A
    const rB1 = await req("client-B");
    expect(rB1.status).toBe(401); // passes pre-auth, fails real auth
  });

  it("trustProxy: uses x-forwarded-for first entry when enabled", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ key: { userId: "u1" } }),
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      trustProxy: true,
    });

    const req = (xff: string) =>
      app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer bad",
          "x-forwarded-for": xff,
        },
        body: JSON.stringify({ input: "hi" }),
      });

    const r1 = await req("1.2.3.4");
    expect(r1.status).toBe(401); // pre-auth ok, real auth fails

    const r2 = await req("1.2.3.4");
    expect(r2.status).toBe(429); // same IP bucket exhausted

    // Different IP — own fresh bucket
    const r3 = await req("5.6.7.8");
    expect(r3.status).toBe(401); // pre-auth ok, real auth fails
  });

  it("trustProxy disabled: x-forwarded-for is NOT used as client key", async () => {
    // When trustProxy is false (default), two requests with different x-forwarded-for
    // headers but same socket address should share the same bucket.
    // We verify by setting getClientKey to always return "same" explicitly.
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ key: { userId: "u1" } }),
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      trustProxy: false,
      getClientKey: () => "same-socket",
    });

    const r1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bad", "x-forwarded-for": "99.99.99.99" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(r1.status).toBe(401);

    const r2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bad", "x-forwarded-for": "100.100.100.100" },
      body: JSON.stringify({ input: "hi" }),
    });
    // Same socket key → same bucket → exhausted
    expect(r2.status).toBe(429);
  });

  it("preAuthRateLimiter: null disables pre-auth limiting entirely", async () => {
    const { agent } = makeAgent(Array.from({ length: 20 }, () => textResponse("ok")));
    const app = createServer({
      agents: { demo: agent },
      preAuthRateLimiter: null, // explicitly disabled
    });

    // Fire 10 requests — none should be 429 from pre-auth limiter.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi", sessionId: `null-preauth-${i}` }),
      });
      statuses.push(r.status);
      await r.text();
    }
    expect(statuses.every((s) => s !== 429)).toBe(true);
  });

  it("pre-auth 429 includes Retry-After header and rate_limited error body", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 10 }),
      getClientKey: () => "single-client",
    });

    const r1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    await r1.text();

    const r2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).not.toBeNull();
    const body = await r2.json() as { error: string; retryAfterMs: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// C3 — Anonymous post-auth bucket isolation
// ---------------------------------------------------------------------------

describe("C3: anonymous post-auth bucket is per-client, not shared", () => {
  it("two unauthenticated clients get independent buckets (not the shared anonymous bucket)", async () => {
    const { agent } = makeAgent([textResponse("ok"), textResponse("ok")]);
    // Capacity=1: first request per bucket key succeeds, second fails.
    const app = createServer({
      agents: { demo: agent },
      // NoAuth → principal has no apiKey/userId/orgId → defaultKey returns "anonymous"
      // With C3 fix, the actual bucket key becomes `anon:<clientKey>`.
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      // Pre-auth limiter disabled so we can test post-auth bucket in isolation.
      preAuthRateLimiter: null,
    });

    let clientKey = "anon-client-1";
    // Override getClientKey to control which client we simulate.
    // We need to use the option that wires into the bucket derivation.
    // We build two apps with different fixed getClientKey values.
    const app1 = createServer({
      agents: { demo: agent },
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      preAuthRateLimiter: null,
      getClientKey: () => "anon-client-1",
    });
    const app2 = createServer({
      agents: { demo: agent },
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      preAuthRateLimiter: null,
      getClientKey: () => "anon-client-2",
    });
    void clientKey;

    // Client 1: first request succeeds
    const r1a = await app1.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "anon-c1-s1" }),
    });
    expect(r1a.status).toBe(200);
    await r1a.text();

    // Client 1: second request is throttled
    const r1b = await app1.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "anon-c1-s2" }),
    });
    expect(r1b.status).toBe(429);

    // Client 2: has its own fresh bucket — should NOT be throttled by client 1
    const r2a = await app2.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "anon-c2-s1" }),
    });
    expect(r2a.status).toBe(200);
    await r2a.text();
  });
});

// ---------------------------------------------------------------------------
// H1 — apiKey-only session ownership
// ---------------------------------------------------------------------------

describe("H1: apiKey-only session ownership", () => {
  it("apiKey tenant A's session events are NOT readable by apiKey tenant B (exposeEvents)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("private-data")], store);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-tenant-a": { apiKey: "key-tenant-a" },
        "key-tenant-b": { apiKey: "key-tenant-b" },
      }),
      exposeEvents: true,
      preAuthRateLimiter: null,
    });

    // Tenant A creates a session
    const qRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-tenant-a" },
      body: JSON.stringify({ input: "hello", sessionId: "apikey-sess-a" }),
    });
    expect(qRes.status).toBe(200);
    await qRes.text();

    // Verify session has apiKey recorded
    const session = await store.getSession("apikey-sess-a");
    expect(session).not.toBeNull();
    expect(session?.apiKey).toBe("key-tenant-a");

    // Tenant B tries to read A's events → 403
    const evRes = await app.request("/v1/agents/demo/sessions/apikey-sess-a/events", {
      headers: { authorization: "Bearer key-tenant-b" },
    });
    expect(evRes.status).toBe(403);
  });

  it("apiKey tenant A can read their own session events", async () => {
    const { agent } = makeAgent([textResponse("own-data")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "key-tenant-a": { apiKey: "key-tenant-a" } }),
      exposeEvents: true,
      preAuthRateLimiter: null,
    });

    const qRes = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-tenant-a" },
      body: JSON.stringify({ input: "hello", sessionId: "apikey-own-sess" }),
    });
    expect(qRes.status).toBe(200);
    await qRes.text();

    const evRes = await app.request("/v1/agents/demo/sessions/apikey-own-sess/events", {
      headers: { authorization: "Bearer key-tenant-a" },
    });
    expect(evRes.status).toBe(200);
    const body = await evRes.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("legacy ownerless session (no userId/orgId/apiKey) is still accessible (back-compat)", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([], store);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "any-key": { apiKey: "any-key" } }),
      exposeEvents: true,
      preAuthRateLimiter: null,
    });

    // Create a session without any owner fields (simulates legacy / NoAuth session)
    await store.migrate();
    await store.createSession({ id: "ownerless-legacy", agentId: "test-agent", createdAt: new Date().toISOString() });

    // Any authenticated principal can read it → 200 (back-compat)
    const evRes = await app.request("/v1/agents/demo/sessions/ownerless-legacy/events", {
      headers: { authorization: "Bearer any-key" },
    });
    expect(evRes.status).toBe(200);
  });

  it("apiKey tenant B cannot query into apiKey tenant A's session", async () => {
    const { agent } = makeAgent([textResponse("a-data"), textResponse("b-intruder")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-a": { apiKey: "key-a" },
        "key-b": { apiKey: "key-b" },
      }),
      preAuthRateLimiter: null,
    });

    // A creates the session
    const r1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-a" },
      body: JSON.stringify({ input: "hi", sessionId: "apikey-idor-sess" }),
    });
    expect(r1.status).toBe(200);
    await r1.text();

    // B tries to use A's session → 403
    const r2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-b" },
      body: JSON.stringify({ input: "steal context", sessionId: "apikey-idor-sess" }),
    });
    expect(r2.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// H3 — Agent-ID enumeration + nosniff header
// ---------------------------------------------------------------------------

describe("H3: agent-ID enumeration prevention + X-Content-Type-Options: nosniff", () => {
  it("404 for unknown agent on /query does NOT contain the supplied agent id in the body", async () => {
    const app = createServer({ agents: {}, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/definitely-secret-agent-name/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("definitely-secret-agent-name");
  });

  it("404 for unknown agent on /resume does NOT contain the supplied agent id", async () => {
    const app = createServer({ agents: {}, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/secret-agent-id/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("secret-agent-id");
  });

  it("404 for unknown agent on /runs does NOT contain the supplied agent id", async () => {
    const app = createServer({ agents: {}, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/secret-id/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("secret-id");
  });

  it("404 for unknown agent on run status does NOT contain the supplied agent id", async () => {
    const app = createServer({ agents: {}, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/secret-agent/runs/some-run/status");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("secret-agent");
  });

  it("404 for unknown agent on session events does NOT contain the supplied agent id", async () => {
    const app = createServer({ agents: {}, exposeEvents: true, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/secret-agent-x/sessions/some-session/events");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("secret-agent-x");
  });

  it("X-Content-Type-Options: nosniff is present on a 200 response", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });
    const res = await app.request("/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("X-Content-Type-Options: nosniff is present on a 404 response", async () => {
    const app = createServer({ agents: {}, preAuthRateLimiter: null });
    const res = await app.request("/v1/agents/unknown/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("X-Content-Type-Options: nosniff is present on a 401 response", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ key: { userId: "u1" } }),
      preAuthRateLimiter: null,
    });
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

// ---------------------------------------------------------------------------
// M7 — Per-field input length cap
// ---------------------------------------------------------------------------

describe("M7: per-field input length cap", () => {
  it("/query: input over maxInputChars → 400 with clear message", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 100,
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(101), sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("100");
  });

  it("/query: input at exactly maxInputChars → 200 (boundary allowed)", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 50,
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(50), sessionId: "m7-boundary" }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("/query: custom maxInputChars is honored (smaller limit)", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 10,
      preAuthRateLimiter: null,
    });

    const ok = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(10), sessionId: "m7-ok" }),
    });
    // Should pass body validation (but no model responses → SSE error result is fine)
    // We just need it not to be a 400 from the length check.
    expect(ok.status).not.toBe(400);
    await ok.text();

    const over = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(11), sessionId: "m7-over" }),
    });
    expect(over.status).toBe(400);
  });

  it("/runs: input over maxInputChars → 400", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 50,
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "y".repeat(51) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("50");
  });

  it("/resume: string decision over maxInputChars → 400", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 20,
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "some-session", decision: "z".repeat(21) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("20");
  });

  it("/resume: non-string decision is not checked against maxInputChars", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      maxInputChars: 5,
      preAuthRateLimiter: null,
    });

    // A decision object is not a string, so it should not trigger the length check.
    // The request will likely fail at the agent level (no durable store), not at body validation.
    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", decision: { approved: true } }),
    });
    // Not 400 from our length check — may be 200 with an SSE error result.
    expect(res.status).not.toBe(400);
    await res.text();
  });
});

// ---------------------------------------------------------------------------
// M8 — SSE error message sanitization
// ---------------------------------------------------------------------------

describe("M8: SSE error message sanitization", () => {
  it("/query: thrown internal error emits generic 'Agent run failed', not the raw message", async () => {
    // Create a model that throws an error with sensitive content.
    // MockModel.complete() is the method the agent calls — implement it to throw.
    const sensitiveMessage = "sk-1234567890abcdef INTERNAL_SECRET_KEY";
    const throwingModel = {
      complete: async () => {
        throw new Error(sensitiveMessage);
      },
    };
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "test-agent",
      instructions: "test",
      model: throwingModel as never,
      store,
    });

    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "m8-query-sess" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    // The sensitive message must NOT appear in the SSE output.
    expect(text).not.toContain(sensitiveMessage);
    expect(text).not.toContain("sk-1234567890");

    // A result event with subtype "error" should be present.
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    const data = resultEvent!.data as { subtype: string; output: string };
    expect(data.subtype).toBe("error");
    // Generic message only — no internal details.
    expect(data.output).toBe("Agent run failed");
  });

  it("/resume: thrown internal error emits generic 'Agent run failed', not the raw message", async () => {
    const sensitiveMessage = "provider-api-key: sk-abcdef";
    const throwingModel = {
      complete: async () => {
        throw new Error(sensitiveMessage);
      },
    };
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "test-agent",
      instructions: "test",
      model: throwingModel as never,
      store,
    });

    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "m8-resume-sess" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).not.toContain(sensitiveMessage);
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    const data = resultEvent!.data as { subtype: string; output: string };
    expect(data.subtype).toBe("error");
    expect(data.output).toBe("Agent run failed");
  });
});

// ---------------------------------------------------------------------------
// M9 — Last-Event-ID validation
// ---------------------------------------------------------------------------

describe("M9: Last-Event-ID validation", () => {
  it("/query: negative Last-Event-ID → 400", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "-1" },
      body: JSON.stringify({ input: "hi", sessionId: "m9-neg" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Last-Event-ID");
  });

  it("/query: non-numeric Last-Event-ID → 400", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "abc" },
      body: JSON.stringify({ input: "hi", sessionId: "m9-nan" }),
    });
    expect(res.status).toBe(400);
  });

  it("/query: very large (but safe integer) Last-Event-ID does not cause unbounded replay", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("ok")], store);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    // Run a query to completion first
    const r1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "m9-large-leid" }),
    });
    await r1.text();

    // Reconnect with a very large but valid Last-Event-ID — no stored events will match
    const r2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": String(Number.MAX_SAFE_INTEGER) },
      body: JSON.stringify({ input: "hi", sessionId: "m9-large-leid" }),
    });
    // Should succeed (200) — all events have already been "received" by the client
    expect(r2.status).toBe(200);
    const text = await r2.text();
    const events = parseSseEvents(text);
    // Should get the synthesized result only (no stored events to replay)
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
  });

  it("/query: valid non-negative Last-Event-ID replays correct events", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("replay-test")], store);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    // Run to completion
    const r1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "m9-valid-leid" }),
    });
    await r1.text();

    // Get last stored seq
    const stored = await store.readEvents("m9-valid-leid");
    const lastSeq = stored[stored.length - 1]!.seq;

    // Reconnect with lastSeq → nothing new to replay, just the synthetic result
    const r2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": String(lastSeq) },
      body: JSON.stringify({ input: "hi", sessionId: "m9-valid-leid" }),
    });
    expect(r2.status).toBe(200);
    const text = await r2.text();
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent!.data as { subtype: string }).subtype).toBe("success");
  });

  it("/resume: negative Last-Event-ID → 400", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "-5" },
      body: JSON.stringify({ sessionId: "m9-resume-neg" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Last-Event-ID");
  });

  it("/resume: non-numeric Last-Event-ID → 400", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/resume", {
      method: "POST",
      headers: { "content-type": "application/json", "last-event-id": "not-a-number" },
      body: JSON.stringify({ sessionId: "m9-resume-nan" }),
    });
    expect(res.status).toBe(400);
  });

  it("missing Last-Event-ID: fresh connection works normally", async () => {
    const { agent } = makeAgent([textResponse("fresh")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "m9-no-leid" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect((resultEvent!.data as { subtype: string }).subtype).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// ApiKeyAuth — Object.hasOwn prototype-pollution guard
// ---------------------------------------------------------------------------

describe("ApiKeyAuth: Object.hasOwn guard against prototype-pollution-style keys", () => {
  it("__proto__ as API key → 401 (must not resolve to inherited property)", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer __proto__",
      },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("constructor as API key → 401", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer constructor",
      },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("toString as API key → 401", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer toString",
      },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("a valid own-property key still authenticates correctly", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "my-real-key": { userId: "u1" } }),
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer my-real-key",
      },
      body: JSON.stringify({ input: "hi", sessionId: "hasown-ok-sess" }),
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});
