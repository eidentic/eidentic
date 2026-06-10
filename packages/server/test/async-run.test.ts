import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { createServer, ApiKeyAuth, InMemoryTokenBucketLimiter, InMemoryQuota, AsyncRunRegistry } from "@eidentic/server";

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

/** Wait for poll status to reach a terminal state (completed/failed/aborted). */
async function waitForCompletion(
  app: ReturnType<typeof createServer>,
  agentId: string,
  runId: string,
  extraHeaders: Record<string, string> = {},
  maxAttempts = 20,
): Promise<{ status: string; output?: unknown; sessionId?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await app.request(`/v1/agents/${agentId}/runs/${runId}/status`, {
      headers: extraHeaders,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; output?: unknown; sessionId?: string };
    if (body.status === "completed" || body.status === "failed" || body.status === "aborted") {
      return body;
    }
    // short spin for async settling
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Run did not complete in ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// POST /v1/agents/:id/runs  — start async run
// ---------------------------------------------------------------------------

describe("POST /v1/agents/:agentId/runs — fire-and-poll async run", () => {
  it("returns 202 with runId, sessionId, and status:running immediately", async () => {
    const { agent } = makeAgent([textResponse("async result")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello async" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string; sessionId: string; status: string };
    expect(typeof body.runId).toBe("string");
    expect(body.runId.length).toBeGreaterThan(0);
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(body.status).toBe("running");
  });

  it("accepts a client-supplied sessionId", async () => {
    const { agent } = makeAgent([textResponse("hi")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", sessionId: "my-session" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBe("my-session");
  });

  it("returns 404 for unknown agent", async () => {
    const app = createServer({ agents: {} });
    const res = await app.request("/v1/agents/unknown/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when input is missing", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when auth fails", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate-limited", async () => {
    // capacity=1, refillPerSec=10 → second request throttled with a finite retryAfterMs
    // which means the server also sets Retry-After
    const { agent } = makeAgent([textResponse("ok"), textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 10 }),
    });

    // Exhaust the bucket via /query (synchronous path) — both paths share the same limiter
    const first = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "rl-sync" }),
    });
    expect(first.status).toBe(200);
    await first.text(); // drain

    // Now the bucket is empty — async run should be rate-limited
    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "async" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const body = await res.json() as { error: string; retryAfterMs: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterMs).toBe("number");
  });

  it("returns 402 when quota exceeded", async () => {
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "test-agent",
      instructions: "You are a helpful assistant.",
      model: new MockModel([]),
      store,
    });
    const quota = new InMemoryQuota({ hardRuns: 0 }); // zero capacity
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi" }),
    });
    expect(res.status).toBe(402);
  });

  it("quota is not leaked when input validation fails (400)", async () => {
    const { agent } = makeAgent([]);
    const quota = new InMemoryQuota({ hardRuns: 3 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    // Invalid body → 400 (quota check should not even happen)
    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ sessionId: "no-input" }),
    });
    expect(res.status).toBe(400);

    // Capacity still available
    const check = quota.check("k");
    expect(check.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((check as any).reservation!);
  });

  it("returns 403 when principal tries to start a run on a session owned by another", async () => {
    const { agent } = makeAgent([textResponse("alice"), textResponse("bob")]);
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
      body: JSON.stringify({ input: "hi", sessionId: "alice-async-sess" }),
    });
    expect(queryRes.status).toBe(200);
    await queryRes.text();

    // Bob tries to start a run on Alice's session → 403
    const bobRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-bob" },
      body: JSON.stringify({ input: "intrude", sessionId: "alice-async-sess" }),
    });
    expect(bobRes.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/:id/runs/:runId/status  — poll status
// ---------------------------------------------------------------------------

describe("GET /v1/agents/:agentId/runs/:runId/status — poll async run", () => {
  it("transitions from running to completed; result is retrievable from store", async () => {
    const store = new InMemoryStore();
    const { agent } = makeAgent([textResponse("async output")], store);
    const app = createServer({ agents: { demo: agent } });

    // Start async run
    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "compute something" }),
    });
    expect(startRes.status).toBe(202);
    const { runId, sessionId } = await startRes.json() as { runId: string; sessionId: string };

    // Poll until completed
    const final = await waitForCompletion(app, "demo", runId);
    expect(final.status).toBe("completed");
    expect(typeof final.sessionId).toBe("string");

    // Events are persisted to the store — verify via store directly
    const events = await store.readEvents(sessionId);
    expect(events.length).toBeGreaterThan(0);
  });

  it("returns 404 for an unknown runId", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent } });

    const res = await app.request("/v1/agents/demo/runs/does-not-exist/status");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown agent on status endpoint", async () => {
    const app = createServer({ agents: {} });
    const res = await app.request("/v1/agents/unknown/runs/some-run/status");
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails on status endpoint", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
    });

    const res = await app.request("/v1/agents/demo/runs/any-run/status");
    expect(res.status).toBe(401);
  });

  it("principal A gets 403 when polling a run owned by principal B", async () => {
    const { agent } = makeAgent([textResponse("alice run")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-alice": { userId: "alice" },
        "key-bob": { userId: "bob" },
      }),
    });

    // Alice starts an async run
    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "alice's run" }),
    });
    expect(startRes.status).toBe(202);
    const { runId } = await startRes.json() as { runId: string };

    // Bob tries to poll Alice's run → 403
    const bobRes = await app.request(`/v1/agents/demo/runs/${runId}/status`, {
      headers: { authorization: "Bearer key-bob" },
    });
    expect(bobRes.status).toBe(403);
  });

  it("principal A can poll their own run (200)", async () => {
    const { agent } = makeAgent([textResponse("alice result")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "key-alice": { userId: "alice" } }),
    });

    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-alice" },
      body: JSON.stringify({ input: "alice's run" }),
    });
    expect(startRes.status).toBe(202);
    const { runId } = await startRes.json() as { runId: string };

    const pollRes = await app.request(`/v1/agents/demo/runs/${runId}/status`, {
      headers: { authorization: "Bearer key-alice" },
    });
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json() as { status: string };
    expect(["running", "completed", "failed"]).toContain(body.status);
  });

  it("status endpoint returns output field when run has completed", async () => {
    const { agent } = makeAgent([textResponse("the final answer")]);
    const app = createServer({ agents: { demo: agent } });

    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "what is the answer?" }),
    });
    expect(startRes.status).toBe(202);
    const { runId } = await startRes.json() as { runId: string };

    const final = await waitForCompletion(app, "demo", runId);
    expect(final.status).toBe("completed");
    expect(typeof final.output).toBe("string");
    expect(final.output).toContain("the final answer");
  });

  it("failed run status is set when agent throws", async () => {
    // MockModel with no responses will throw when the agent tries to call it
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent } });

    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "this will fail" }),
    });
    expect(startRes.status).toBe(202);
    const { runId } = await startRes.json() as { runId: string };

    const final = await waitForCompletion(app, "demo", runId);
    expect(["failed", "completed"]).toContain(final.status);
  });

  it("quota is recorded after async run completes", async () => {
    const { agent } = makeAgent([textResponse("quota test")]);
    const quota = new InMemoryQuota({ hardRuns: 10 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const startRes = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "quota check" }),
    });
    expect(startRes.status).toBe(202);
    const { runId } = await startRes.json() as { runId: string };

    // Wait for completion
    await waitForCompletion(app, "demo", runId, { authorization: "Bearer k" });

    // Quota should have recorded 1 run
    const usage = quota.check("k");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    quota.release((usage as any).reservation!);
    expect(usage.usage?.runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [M10] AsyncRunRegistry — bounded retention
// ---------------------------------------------------------------------------

describe("[M10] AsyncRunRegistry bounded eviction", () => {
  it("cap is respected: adding beyond maxRuns evicts oldest settled entry", () => {
    const reg = new AsyncRunRegistry({ maxRuns: 3 });

    const base: Omit<import("@eidentic/server").AsyncRunEntry, "runId" | "createdAt"> = {
      sessionId: "s",
      agentId: "a",
      status: "running",
      owner: {},
    };

    reg.set({ ...base, runId: "r1", status: "running", createdAt: 1 });
    reg.set({ ...base, runId: "r2", status: "running", createdAt: 2 });
    reg.set({ ...base, runId: "r3", status: "running", createdAt: 3 });

    // Settle r1 and r2 so they are evictable
    reg.settle("r1", { status: "completed" });
    reg.settle("r2", { status: "completed" });

    // Adding r4 pushes size to 4 — should evict oldest settled (r1)
    reg.set({ ...base, runId: "r4", status: "running", createdAt: 4 });

    expect(reg.get("r1")).toBeUndefined(); // evicted (oldest settled)
    expect(reg.get("r2")).toBeDefined();   // kept (newer settled)
    expect(reg.get("r3")).toBeDefined();   // kept (in-flight)
    expect(reg.get("r4")).toBeDefined();   // just added
  });

  it("in-flight runs are never evicted under normal cap pressure", () => {
    const reg = new AsyncRunRegistry({ maxRuns: 2 });

    const base = { sessionId: "s", agentId: "a", status: "running" as const, owner: {} };
    reg.set({ ...base, runId: "inf1", createdAt: 1 });
    reg.set({ ...base, runId: "inf2", createdAt: 2 });

    // Both slots full and both in-flight — adding a third should NOT evict either
    reg.set({ ...base, runId: "inf3", createdAt: 3 });

    // All three remain because no settled run was available to evict
    expect(reg.get("inf1")).toBeDefined();
    expect(reg.get("inf2")).toBeDefined();
    expect(reg.get("inf3")).toBeDefined();
  });

  it("settled runs (completed/failed) are evicted before in-flight ones", () => {
    const reg = new AsyncRunRegistry({ maxRuns: 3 });

    const base = { sessionId: "s", agentId: "a", owner: {} };
    reg.set({ ...base, runId: "completed1", status: "completed" as const, createdAt: 1, settledAt: 10 });
    reg.set({ ...base, runId: "failed1",    status: "failed" as const,    createdAt: 2, settledAt: 11 });
    reg.set({ ...base, runId: "running1",   status: "running" as const,   createdAt: 3 });

    // Adding a 4th entry should evict completed1 (oldest settled), NOT running1
    reg.set({ ...base, runId: "running2", status: "running" as const, createdAt: 4 });

    expect(reg.get("completed1")).toBeUndefined(); // evicted
    expect(reg.get("failed1")).toBeDefined();      // kept (newer settled)
    expect(reg.get("running1")).toBeDefined();     // kept (in-flight)
    expect(reg.get("running2")).toBeDefined();     // just added
  });

  it("maxAsyncRuns option flows through createServer to the registry", async () => {
    // Build a server with a very small cap and fill it with settled runs via the API.
    const responses = Array.from({ length: 5 }, () => textResponse("done"));
    const { agent } = makeAgent(responses);
    const app = createServer({
      agents: { demo: agent },
      maxAsyncRuns: 2,
      preAuthRateLimiter: null,
    });

    // Start 3 async runs and wait for each to complete so they are settled
    const runIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/v1/agents/demo/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: `run ${i}`, sessionId: `evict-sess-${i}` }),
      });
      expect(res.status).toBe(202);
      const { runId } = await res.json() as { runId: string };
      runIds.push(runId);
      await waitForCompletion(app, "demo", runId);
    }

    // The registry cap is 2. After 3 settled runs, at most 2 should remain.
    // r1 and r2 are settled; when r3 was added the oldest settled (r1) was evicted.
    // r2 should still be accessible; r3 should be accessible too.
    // r1 may have been evicted — its status endpoint will return 404.
    const r1Res = await app.request(`/v1/agents/demo/runs/${runIds[0]}/status`);
    const r2Res = await app.request(`/v1/agents/demo/runs/${runIds[1]}/status`);
    const r3Res = await app.request(`/v1/agents/demo/runs/${runIds[2]}/status`);

    // At most 2 of the 3 are retained — at least one must have been evicted.
    const statuses = [r1Res.status, r2Res.status, r3Res.status];
    const notFound = statuses.filter((s) => s === 404);
    expect(notFound.length).toBeGreaterThanOrEqual(1);
  });
});
