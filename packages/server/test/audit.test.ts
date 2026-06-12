/**
 * Tests for the server-owned audit events (§10.4/§15): the `onAuditEvent` sink on `createServer`
 * emits structured `AuditEvent`s for security-relevant rejections at the HTTP edge —
 * `auth.failure` (401), `ratelimit.exceeded` (429), and `quota.exceeded` (402). Best-effort: a
 * throwing sink never affects request handling.
 */
import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { AuditEvent, ModelResponse } from "@eidentic/types";
import { createServer, ApiKeyAuth, InMemoryTokenBucketLimiter, InMemoryQuota } from "@eidentic/server";

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }], usage: { inputTokens: 10, outputTokens: 5 } };
}

function makeAgent(responses: ModelResponse[]) {
  const store = new InMemoryStore();
  const agent = new Agent({ id: "demo", instructions: "test", model: new MockModel(responses), store });
  return { agent, store };
}

const QUERY = "/v1/agents/demo/query";

describe("server audit: auth.failure", () => {
  it("emits auth.failure with the route on a 401", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const events: AuditEvent[] = [];
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "secret-key": { userId: "user-1" } }),
      onAuditEvent: (e) => events.push(e),
    });

    const res = await app.request(QUERY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(401);

    const auth = events.filter((e) => e.type === "auth.failure");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.type === "auth.failure" && auth[0]!.route).toBe(QUERY);
  });
});

describe("server audit: ratelimit.exceeded", () => {
  it("emits ratelimit.exceeded (with principalId + route) when the pre-auth limiter throttles a 429", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const events: AuditEvent[] = [];
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "secret-key": { userId: "user-1" } }),
      // capacity 1, no refill → the 2nd request in the same window is throttled
      preAuthRateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 0 }),
      onAuditEvent: (e) => events.push(e),
    });

    const req = () =>
      app.request(QUERY, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({ input: "hi", sessionId: "s1" }),
      });

    await req();
    const r2 = await req();
    expect(r2.status).toBe(429);

    const rl = events.filter((e) => e.type === "ratelimit.exceeded");
    expect(rl.length).toBeGreaterThanOrEqual(1);
    const e = rl[0]!;
    if (e.type !== "ratelimit.exceeded") throw new Error("narrowing");
    expect(e.route).toBe(QUERY);
    expect(typeof e.principalId).toBe("string");
  });
});

describe("server audit: quota.exceeded", () => {
  it("emits quota.exceeded (with scopeKey) on a 402", async () => {
    const { agent } = makeAgent([textResponse("first"), textResponse("second")]);
    const events: AuditEvent[] = [];
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ k: { userId: "u1", apiKey: "k" } }),
      quota: new InMemoryQuota({ hardRuns: 1 }),
      onAuditEvent: (e) => events.push(e),
    });

    const makeReq = (sessionId: string) =>
      app.request(QUERY, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ input: "hi", sessionId }),
      });

    const first = await makeReq("q-1");
    expect(first.status).toBe(200);
    await first.text();
    const second = await makeReq("q-2");
    expect(second.status).toBe(402);

    const q = events.filter((e) => e.type === "quota.exceeded");
    expect(q).toHaveLength(1);
    const e = q[0]!;
    if (e.type !== "quota.exceeded") throw new Error("narrowing");
    expect(typeof e.scopeKey).toBe("string");
  });
});

describe("server audit: best-effort contract", () => {
  it("a throwing sink never affects request handling", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "secret-key": { userId: "user-1" } }),
      onAuditEvent: () => { throw new Error("sink boom"); },
    });

    const res = await app.request(QUERY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    // The 401 is still produced despite the throwing sink.
    expect(res.status).toBe(401);
  });
});
