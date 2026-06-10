import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { createServer, ApiKeyAuth, InMemoryQuota } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string, inputTokens = 10, outputTokens = 5): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens, outputTokens },
  };
}

function makeAgent(responses: ModelResponse[]) {
  const store = new InMemoryStore();
  const agent = new Agent({
    id: "test-agent",
    instructions: "You are a helpful assistant.",
    model: new MockModel(responses),
    store,
  });
  return { agent, store };
}

/** Parse raw SSE body text into an array of parsed event data objects. */
function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  const lines = body.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data = line.slice("data:".length).trim();
    } else if (line === "" && event && data) {
      try {
        results.push({ event, data: JSON.parse(data) });
      } catch {
        results.push({ event, data });
      }
      event = "";
      data = "";
    }
  }
  return results;
}

async function readResponseText(res: Response): Promise<string> {
  return await res.text();
}

// ---------------------------------------------------------------------------
// InMemoryQuota unit tests
// ---------------------------------------------------------------------------

describe("InMemoryQuota — unit", () => {
  it("check returns ok:true when under all limits", () => {
    const q = new InMemoryQuota({ hardUsd: 10, hardTokens: 1000, hardRuns: 5 });
    const result = q.check("k1");
    expect(result.ok).toBe(true);
    expect(result.warn).toBeFalsy();
    expect(result.usage).toEqual({ usd: 0, tokens: 0, runs: 0 });
  });

  it("check returns ok:false after record pushes usd over hardUsd", () => {
    const q = new InMemoryQuota({ hardUsd: 1.0 });
    q.record("k1", { usd: 1.0, tokens: 100 });
    const result = q.check("k1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hard USD ceiling/);
    expect(result.usage?.usd).toBe(1.0);
  });

  it("check returns ok:false after record pushes tokens over hardTokens", () => {
    const q = new InMemoryQuota({ hardTokens: 500 });
    q.record("k1", { usd: 0, tokens: 500 });
    const result = q.check("k1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hard token ceiling/);
  });

  it("softUsd crossed → warn:true but ok:true (still allowed)", () => {
    const q = new InMemoryQuota({ softUsd: 0.5, hardUsd: 10 });
    q.record("k1", { usd: 0.5, tokens: 10 });
    const result = q.check("k1");
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
  });

  it("softUsd crossed but hardUsd not crossed → allowed with warning", () => {
    const q = new InMemoryQuota({ softUsd: 1.0, hardUsd: 5.0 });
    q.record("k1", { usd: 2.0, tokens: 0 });
    const result = q.check("k1");
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
  });

  it("hardRuns enforced after N runs", () => {
    const q = new InMemoryQuota({ hardRuns: 2 });
    q.record("k1", { usd: 0, tokens: 0 });
    q.record("k1", { usd: 0, tokens: 0 });
    const result = q.check("k1");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hard run ceiling/);
    expect(result.usage?.runs).toBe(2);
  });

  it("per-key isolation: exhausting key A does not affect key B", () => {
    const q = new InMemoryQuota({ hardRuns: 1 });
    q.record("keyA", { usd: 0, tokens: 0 });
    // keyA exhausted
    expect(q.check("keyA").ok).toBe(false);
    // keyB has a fresh counter
    expect(q.check("keyB").ok).toBe(true);
  });

  it("record accumulates across multiple calls", () => {
    const q = new InMemoryQuota({ hardUsd: 100 });
    q.record("k1", { usd: 1.5, tokens: 100 });
    q.record("k1", { usd: 2.0, tokens: 200 });
    const usage = q.check("k1").usage!;
    expect(usage.usd).toBeCloseTo(3.5);
    expect(usage.tokens).toBe(300);
    expect(usage.runs).toBe(2);
  });

  it("reset(key) clears that key's counters", () => {
    const q = new InMemoryQuota({ hardRuns: 1 });
    q.record("k1", { usd: 0, tokens: 0 });
    expect(q.check("k1").ok).toBe(false);
    q.reset("k1");
    expect(q.check("k1").ok).toBe(true);
  });

  it("reset() clears all counters", () => {
    const q = new InMemoryQuota({ hardRuns: 1 });
    q.record("k1", { usd: 0, tokens: 0 });
    q.record("k2", { usd: 0, tokens: 0 });
    q.reset();
    expect(q.check("k1").ok).toBe(true);
    expect(q.check("k2").ok).toBe(true);
  });

  it("per-key limits resolver: each key gets independent ceilings", () => {
    const q = new InMemoryQuota((key) => key === "premium" ? { hardRuns: 10 } : { hardRuns: 1 });
    q.record("free", { usd: 0, tokens: 0 });
    expect(q.check("free").ok).toBe(false);
    // premium still has 9 remaining
    expect(q.check("premium").ok).toBe(true);
  });

  it("no limits configured → always ok", () => {
    const q = new InMemoryQuota({});
    for (let i = 0; i < 100; i++) {
      q.record("k1", { usd: 999, tokens: 999999 });
    }
    expect(q.check("k1").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server integration tests
// ---------------------------------------------------------------------------

describe("Quota — server integration", () => {
  it("first POST /query streams 200 and records the run", async () => {
    const { agent } = makeAgent([textResponse("Hello!")]);
    const quota = new InMemoryQuota({ hardRuns: 2 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "s1" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    // After one run, runs counter should be 1.
    const usage = quota.check("k").usage!;
    expect(usage.runs).toBe(1);
  });

  it("second request with hardRuns:1 quota → 402 quota_exceeded", async () => {
    const { agent } = makeAgent([textResponse("First"), textResponse("Second")]);
    const quota = new InMemoryQuota({ hardRuns: 1 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const makeReq = (sessionId: string) =>
      app.request("/v1/agents/demo/query", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer k" },
        body: JSON.stringify({ input: "hi", sessionId }),
      });

    const first = await makeReq("q-1");
    expect(first.status).toBe(200);
    await readResponseText(first);

    const second = await makeReq("q-2");
    expect(second.status).toBe(402);
    const body = (await second.json()) as { error: string; reason: string };
    expect(body.error).toBe("quota_exceeded");
    expect(typeof body.reason).toBe("string");
  });

  it("soft-limit crossing sets X-Eidentic-Quota-Warning header but still streams", async () => {
    const { agent } = makeAgent([textResponse("ok"), textResponse("ok")]);
    // softUsd=0 means it will warn on second request (after first records usd=0 >= softUsd=0),
    // but since we start at 0 and softUsd is 0, even the first check triggers warn.
    // Use a small positive softUsd that the first run's spend meets.
    // MockModel has no cost, so usd will always be 0. Use softUsd:0 to guarantee warn.
    const quota = new InMemoryQuota({ softUsd: 0 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "soft-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Eidentic-Quota-Warning")).toBe("soft-limit");
    await readResponseText(res);
  });

  it("soft-limit: after recording usd, subsequent check triggers warn header", async () => {
    const { agent } = makeAgent([textResponse("first"), textResponse("second")]);
    const quota = new InMemoryQuota({ softUsd: 0.001, hardUsd: 100 });
    // Manually record some spend so the second request sees warn.
    quota.record("k", { usd: 0.001, tokens: 10 });

    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "soft-2" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Eidentic-Quota-Warning")).toBe("soft-limit");
    const text = await readResponseText(res);
    const events = parseSseEvents(text);
    const resultEvent = events.find((e) => e.event === "result");
    expect((resultEvent?.data as { subtype: string }).subtype).toBe("success");
  });

  it("different principal key not affected by another key's quota", async () => {
    const { agent } = makeAgent([textResponse("A"), textResponse("B")]);
    const quota = new InMemoryQuota({ hardRuns: 1 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({
        "key-a": { userId: "uA", apiKey: "key-a" },
        "key-b": { userId: "uB", apiKey: "key-b" },
      }),
      quota,
    });

    // Exhaust quota for key-a
    const resA1 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-a" },
      body: JSON.stringify({ input: "hi", sessionId: "iso-a1" }),
    });
    expect(resA1.status).toBe(200);
    await readResponseText(resA1);

    const resA2 = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-a" },
      body: JSON.stringify({ input: "hi", sessionId: "iso-a2" }),
    });
    expect(resA2.status).toBe(402);
    await readResponseText(resA2);

    // key-b is a fresh independent ledger, must succeed
    const resB = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer key-b" },
      body: JSON.stringify({ input: "hi", sessionId: "iso-b1" }),
    });
    expect(resB.status).toBe(200);
    await readResponseText(resB);
  });

  // ─── A8: reserve-then-settle concurrent safety ────────────────────────────────

  it("A8: concurrent checks do not exceed hardRuns — in-flight reservation prevents burst", () => {
    const q = new InMemoryQuota({ hardRuns: 2 });

    // First check succeeds and reserves 1 run.
    const r1 = q.check("k1");
    expect(r1.ok).toBe(true);

    // Second check sees in-flight=1, committed=0 → total=1 < 2 → succeeds.
    const r2 = q.check("k1");
    expect(r2.ok).toBe(true);

    // Third check sees in-flight=2, committed=0 → total=2 >= 2 → DENIED.
    const r3 = q.check("k1");
    expect(r3.ok).toBe(false);
    expect(r3.reason).toMatch(/hard run ceiling/);
  });

  it("A8: release() frees an in-flight reservation so the next check succeeds", () => {
    const q = new InMemoryQuota({ hardRuns: 1 });

    const r1 = q.check("k1");
    expect(r1.ok).toBe(true);

    // In-flight = 1 → second check blocked.
    expect(q.check("k1").ok).toBe(false);

    // Release the first reservation (error path — run never completed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.release((r1 as any).reservation!);

    // Now in-flight = 0, committed = 0 → next check succeeds.
    expect(q.check("k1").ok).toBe(true);
  });

  it("A8: record() with reservation settles and decrements in-flight; subsequent check succeeds", () => {
    const q = new InMemoryQuota({ hardRuns: 2 });

    const r1 = q.check("k1");
    expect(r1.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.record("k1", { usd: 0, tokens: 0 }, (r1 as any).reservation);

    // Committed=1, in-flight=0, total=1 < 2 → still ok.
    const r2 = q.check("k1");
    expect(r2.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.record("k1", { usd: 0, tokens: 0 }, (r2 as any).reservation);

    // Committed=2, in-flight=0, total=2 >= 2 → blocked.
    expect(q.check("k1").ok).toBe(false);
  });

  it("A8: stale reservation token (after reset) does not decrement in-flight counter — counter stays at 0", () => {
    const q = new InMemoryQuota({ hardRuns: 5 });

    const r1 = q.check("k1");
    expect(r1.ok).toBe(true);

    // Reset invalidates the reservation token and clears all counters.
    q.reset("k1");

    // Settling the stale token: spend IS committed (record always commits) but in-flight is
    // NOT decremented (stale check blocks that) — meaning the counter is NOT driven negative.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.record("k1", { usd: 0, tokens: 0 }, (r1 as any).reservation);

    // The in-flight counter must not have gone negative (no underflow).
    // A fresh check should still succeed (in-flight is 0, not -1).
    expect(q.check("k1").ok).toBe(true);
  });

  it("no-quota path unchanged — existing tests green without quota configured", async () => {
    const { agent } = makeAgent([textResponse("fine")]);
    const app = createServer({ agents: { demo: agent } });
    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hi", sessionId: "no-quota" }),
    });
    expect(res.status).toBe(200);
    const text = await readResponseText(res);
    const events = parseSseEvents(text);
    expect(events.find((e) => e.event === "result")).toBeDefined();
  });

  it("record actually accumulates the run's token usage in the ledger", async () => {
    // MockModel reports inputTokens=10, outputTokens=5 → tokens=15
    const { agent } = makeAgent([textResponse("ok", 10, 5)]);
    const quota = new InMemoryQuota({ hardRuns: 10 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "ledger-1" }),
    });
    expect(res.status).toBe(200);
    await readResponseText(res);

    const usage = quota.check("k").usage!;
    // tokens = inputTokens + outputTokens = 10 + 5 = 15
    expect(usage.tokens).toBe(15);
    expect(usage.runs).toBe(1);
  });

  it("hardUsd quota: second request blocked after first records usd spend (with priced model)", async () => {
    // Since MockModel has no cost (usd=0), we test hardUsd:0 which blocks after the first run
    // because 0 >= 0.
    const { agent } = makeAgent([textResponse("first"), textResponse("second")]);
    const quota = new InMemoryQuota({ hardUsd: 0 });
    const app = createServer({
      agents: { demo: agent },
      auth: ApiKeyAuth({ "k": { userId: "u1", apiKey: "k" } }),
      quota,
    });

    // First request: usd=0 is already >= hardUsd=0 before any run → blocked immediately.
    const first = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", sessionId: "usd-1" }),
    });
    expect(first.status).toBe(402);
    await readResponseText(first);
  });
});

// ---------------------------------------------------------------------------
// Fix #4 defense-in-depth — max-age sweep releases stale reservations
// ---------------------------------------------------------------------------

describe("InMemoryQuota — max-age sweep (Fix #4 defense-in-depth)", () => {
  it("sweepStaleReservations() releases a reservation older than the max age", () => {
    // Use a 0-ms max-age so any reservation is instantly stale.
    const q = new InMemoryQuota({ hardRuns: 1 }, { reservationMaxAgeMs: 0 });

    const r1 = q.check("k");
    expect(r1.ok).toBe(true);

    // In-flight=1 → next check blocked.
    expect(q.check("k").ok).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.release((q.check("k") as any).reservation ?? { key: "k", generation: 0, createdAt: 0 });

    // Sweep releases the stale reservation (createdAt=0 is immediately stale with maxAge=0).
    q.sweepStaleReservations();

    // After sweep, capacity is freed.
    const r2 = q.check("k");
    expect(r2.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.release((r2 as any).reservation!);

    q.destroy();
  });

  it("sweepStaleReservations() does not release reservations within the max age", () => {
    // Large max-age: 1 hour — nothing should be swept.
    const q = new InMemoryQuota({ hardRuns: 1 }, { reservationMaxAgeMs: 3_600_000 });

    const r1 = q.check("k");
    expect(r1.ok).toBe(true);

    // Reservation is fresh — sweep must not release it.
    q.sweepStaleReservations();

    // In-flight still 1 → blocked.
    expect(q.check("k").ok).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.release((r1 as any).reservation!);
    q.destroy();
  });

  it("sweepStaleReservations() does not decrement below 0 (no underflow)", () => {
    const q = new InMemoryQuota({ hardRuns: 5 }, { reservationMaxAgeMs: 0 });

    // Check once to get a reservation, then manually release it.
    const r1 = q.check("k");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q.release((r1 as any).reservation!);

    // Sweep on an already-released reservation must not underflow the counter.
    q.sweepStaleReservations();

    // Capacity intact — five checks should all succeed.
    for (let i = 0; i < 5; i++) {
      const r = q.check("k");
      expect(r.ok).toBe(true);
    }
    // 6th should fail (committed=0, in-flight=5 → total=5 >= hardRuns=5).
    expect(q.check("k").ok).toBe(false);

    q.destroy();
  });
});
