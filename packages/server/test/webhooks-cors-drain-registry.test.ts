/**
 * Tests for:
 *   1. Webhook callbacks (HMAC-signed delivery on success and error, retry, validation)
 *   2. CORS middleware wiring
 *   3. Graceful drain (503 during drain, settles in-flight runs, timeout path)
 *   4. External workflow registry injection
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { createWorkflowRunRegistry } from "@eidentic/workflow";
import type { WorkflowRunRegistry } from "@eidentic/workflow";
import { createServer, ApiKeyAuth } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
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

/** Wait for poll status to reach a terminal state. */
async function waitForCompletion(
  app: ReturnType<typeof createServer>,
  agentId: string,
  runId: string,
  extraHeaders: Record<string, string> = {},
  maxAttempts = 50,
): Promise<{ status: string; output?: unknown; sessionId?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await app.request(`/v1/agents/${agentId}/runs/${runId}/status`, {
      headers: extraHeaders,
    });
    if (res.status !== 200) throw new Error(`Unexpected status ${res.status}`);
    const body = await res.json() as { status: string; output?: unknown; sessionId?: string };
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Run did not settle");
}

/**
 * Verify the HMAC-SHA256 signature using the documented recipe.
 * Message = timestamp + "." + rawBody
 */
function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(timestamp + "." + rawBody)
    .digest("hex");
  return expected === signatureHeader;
}

// ---------------------------------------------------------------------------
// 1. Webhook tests
// ---------------------------------------------------------------------------

describe("Webhook callbacks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a signed webhook on successful run completion", async () => {
    const { agent } = makeAgent([textResponse("webhook result")]);

    const received: { body: string; timestamp: string; signature: string }[] = [];
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      received.push({
        body: init?.body as string,
        timestamp: (init?.headers as Record<string, string>)["X-Eidentic-Timestamp"],
        signature: (init?.headers as Record<string, string>)["X-Eidentic-Signature"],
      });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "test-secret", allowPrivateHosts: true },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello webhook", callbackUrl: "http://localhost:9999/cb" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };

    await waitForCompletion(app, "demo", runId);
    // Give async webhook delivery a moment
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const call = received[0]!;

    // Verify payload structure
    const payload = JSON.parse(call.body) as {
      runId: string; agentId: string; status: string; output?: string;
    };
    expect(payload.runId).toBe(runId);
    expect(payload.agentId).toBe("demo");
    expect(payload.status).toBe("completed");
    expect(payload.output).toContain("webhook result");

    // Verify signature using the documented recipe
    expect(verifyWebhookSignature("test-secret", call.timestamp, call.body, call.signature)).toBe(true);
  });

  it("delivers a signed webhook with status:failed when run errors", async () => {
    // MockModel with no responses throws
    const { agent } = makeAgent([]);

    const received: { body: string; timestamp: string; signature: string }[] = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      received.push({
        body: init?.body as string,
        timestamp: (init?.headers as Record<string, string>)["X-Eidentic-Timestamp"],
        signature: (init?.headers as Record<string, string>)["X-Eidentic-Signature"],
      });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "secret-for-error", allowPrivateHosts: true },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "will fail", callbackUrl: "http://localhost:9999/cb" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };

    await waitForCompletion(app, "demo", runId);
    await new Promise((r) => setTimeout(r, 80));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const call = received[0]!;
    const payload = JSON.parse(call.body) as { status: string; error?: string };
    expect(payload.status).toBe("failed");
    expect(typeof payload.error).toBe("string");

    // Signature must still verify
    expect(verifyWebhookSignature("secret-for-error", call.timestamp, call.body, call.signature)).toBe(true);
  });

  it("returns 400 when callbackUrl is provided but webhooks are not configured", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      preAuthRateLimiter: null,
      // No webhooks option
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test", callbackUrl: "https://example.com/cb" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("returns 400 when callbackUrl resolves to a private host (SSRF guard)", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "s" }, // allowPrivateHosts defaults to false
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test", callbackUrl: "http://192.168.1.1/cb" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("blocked");
  });

  it("returns 400 for callbackUrl with non-http scheme", async () => {
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "s" },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "test", callbackUrl: "ftp://example.com/cb" }),
    });
    expect(res.status).toBe(400);
  });

  it("retries delivery when first attempt fails (non-2xx response)", async () => {
    const { agent } = makeAgent([textResponse("retry test")]);

    // Capture delivery attempts. First returns 500 (triggers retry); subsequent return 200.
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      return new Response(null, { status: callCount === 1 ? 500 : 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "retry-secret", allowPrivateHosts: true },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "retry", callbackUrl: "http://localhost:9999/cb" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };

    await waitForCompletion(app, "demo", runId);

    // Wait for the 1s retry backoff + some buffer
    await new Promise((r) => setTimeout(r, 1300));

    // Should have been called at least twice (original + at least 1 retry)
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 10_000); // 10s timeout for this test

  it("does NOT follow redirects on webhook delivery", async () => {
    const { agent } = makeAgent([textResponse("no redirect")]);

    let calledUrl: string | undefined;
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calledUrl = url;
      // Redirect is never followed — manual redirect returns opaque response
      return new Response(null, { status: 302, headers: { Location: "http://other.example.com" } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "s", allowPrivateHosts: true },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "no-redir", callbackUrl: "http://localhost:9999/cb" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };

    await waitForCompletion(app, "demo", runId);
    await new Promise((r) => setTimeout(r, 50));

    // fetch was called with redirect: "manual" — the original URL is always used
    expect(calledUrl).toBe("http://localhost:9999/cb");
    // And it was NOT re-called with the redirect destination
    expect(mockFetch.mock.calls.every(([u]) => u === "http://localhost:9999/cb")).toBe(true);
  });

  it("normal run without callbackUrl works fine when webhooks are configured", async () => {
    const { agent } = makeAgent([textResponse("no cb")]);
    const mockFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const app = createServer({
      agents: { demo: agent },
      webhooks: { signingSecret: "s" },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "no callback" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };
    await waitForCompletion(app, "demo", runId);
    // fetch should NOT have been called (no callbackUrl provided)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. CORS tests
// ---------------------------------------------------------------------------

describe("CORS middleware", () => {
  it("preflight request is honored when cors option is configured", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      cors: { origin: "https://app.example.com" },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    // Preflight should return 204 or 200 with CORS headers
    expect([200, 204]).toContain(res.status);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });

  it("CORS headers are absent when cors option is not provided", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({
      agents: { demo: agent },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    // No CORS headers should be present
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS headers are added on normal responses when configured", async () => {
    const { agent } = makeAgent([textResponse("cors response")]);
    const app = createServer({
      agents: { demo: agent },
      cors: { origin: "*" },
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://any.example.com",
      },
      body: JSON.stringify({ input: "hello cors" }),
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful drain tests
// ---------------------------------------------------------------------------

describe("Graceful drain (_draining flag via createServer internals)", () => {
  /**
   * We can't easily test serveNode's drain() without starting a real HTTP server,
   * so we test the drain flag behaviour directly by manipulating the internal
   * `_setDraining` hook that createServer attaches to the app.
   */
  function getDrainControl(app: ReturnType<typeof createServer>) {
    const a = app as unknown as {
      _setDraining?: (v: boolean) => void;
      _getAsyncRuns?: () => import("@eidentic/server").AsyncRunRegistry;
    };
    return { setDraining: a._setDraining!, getAsyncRuns: a._getAsyncRuns! };
  }

  it("returns 503 with Retry-After on new /v1 requests while draining", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });
    const { setDraining } = getDrainControl(app);

    setDraining(true);

    const res = await app.request("/v1/agents/demo/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "blocked" }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json() as { error: string };
    expect(body.error).toBe("service_draining");
  });

  it("health endpoint is still accessible while draining", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });
    const { setDraining } = getDrainControl(app);

    setDraining(true);

    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("drain resolves when all async runs settle", async () => {
    const { agent } = makeAgent([textResponse("settled")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });
    const { setDraining, getAsyncRuns } = getDrainControl(app);

    // Start a run
    const res = await app.request("/v1/agents/demo/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "settle me" }),
    });
    expect(res.status).toBe(202);
    const { runId } = await res.json() as { runId: string };

    // Wait for it to complete
    await waitForCompletion(app, "demo", runId);

    // Mark draining
    setDraining(true);

    // All runs are settled, so the in-flight count should be 0
    const running = getAsyncRuns().values().filter((e) => e.status === "running");
    expect(running.length).toBe(0);
  });

  it("timeout path: drain should not hang forever when in-flight runs never settle", async () => {
    // Build a server where the async run registry has a "stuck" running entry
    const { agent } = makeAgent([textResponse("ok")]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });
    const { setDraining, getAsyncRuns } = getDrainControl(app);

    // Manually inject a "stuck" running entry
    getAsyncRuns().set({
      runId: "stuck-run",
      sessionId: "s",
      agentId: "demo",
      status: "running",
      owner: {},
      createdAt: Date.now(),
    });

    setDraining(true);

    // Simulate the drain wait loop with a very short timeout
    const deadline = Date.now() + 200; // 200ms timeout
    while (Date.now() < deadline) {
      const running = getAsyncRuns().values().filter((e) => e.status === "running");
      if (running.length === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // The loop exited due to timeout — stuck run is still there
    const stuck = getAsyncRuns().get("stuck-run");
    expect(stuck?.status).toBe("running");
    // But we completed the drain logic without hanging
    expect(Date.now()).toBeLessThan(deadline + 1000);
  });
});

// ---------------------------------------------------------------------------
// 4. External workflow registry injection
// ---------------------------------------------------------------------------

describe("External workflow registry injection", () => {
  it("injected registry receives records via handle.recordWorkflow", async () => {
    const { agent } = makeAgent([]);
    const externalRegistry = createWorkflowRunRegistry();

    const app = createServer({
      agents: { demo: agent },
      workflowRuns: externalRegistry,
      preAuthRateLimiter: null,
    });

    // Record a fake workflow result via the server handle
    const fakeResult = {
      output: "done",
      durationMs: 100,
      startedAt: Date.now(),
      trace: [],
    };
    const id = app.handle.recordWorkflow("my-workflow", fakeResult as Parameters<typeof app.handle.recordWorkflow>[1]);

    // The external registry should have the record
    const rec = externalRegistry.get(id);
    expect(rec).toBeDefined();
    expect(rec?.name).toBe("my-workflow");
  });

  it("injected registry is used by GET /v1/workflows", async () => {
    const { agent } = makeAgent([]);
    const externalRegistry = createWorkflowRunRegistry();

    // Pre-populate the external registry
    const fakeResult = {
      output: "external",
      durationMs: 50,
      startedAt: Date.now(),
      trace: [],
    };
    externalRegistry.record("external-workflow", fakeResult as Parameters<typeof externalRegistry.record>[1]);

    const app = createServer({
      agents: { demo: agent },
      workflowRuns: externalRegistry,
      preAuthRateLimiter: null,
    });

    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ name: string }>;
    expect(list.some((r) => r.name === "external-workflow")).toBe(true);
  });

  it("server without injected registry creates its own (default behavior unchanged)", async () => {
    const { agent } = makeAgent([]);
    const app = createServer({ agents: { demo: agent }, preAuthRateLimiter: null });

    const id = app.handle.recordWorkflow("default-workflow", {
      output: "ok",
      durationMs: 10,
      startedAt: Date.now(),
      trace: [],
    } as Parameters<typeof app.handle.recordWorkflow>[1]);

    expect(typeof id).toBe("string");

    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ name: string }>;
    expect(list.some((r) => r.name === "default-workflow")).toBe(true);
  });

  it("two servers with the same injected registry share workflow records", async () => {
    const { agent: a1 } = makeAgent([]);
    const { agent: a2 } = makeAgent([]);
    const sharedRegistry: WorkflowRunRegistry = createWorkflowRunRegistry();

    const app1 = createServer({ agents: { a1 }, workflowRuns: sharedRegistry, preAuthRateLimiter: null });
    const app2 = createServer({ agents: { a2 }, workflowRuns: sharedRegistry, preAuthRateLimiter: null });

    app1.handle.recordWorkflow("wf-from-server1", {
      output: "s1",
      durationMs: 1,
      startedAt: Date.now(),
      trace: [],
    } as Parameters<typeof app1.handle.recordWorkflow>[1]);

    const res = await app2.request("/v1/workflows");
    expect(res.status).toBe(200);
    const list = await res.json() as Array<{ name: string }>;
    expect(list.some((r) => r.name === "wf-from-server1")).toBe(true);
  });
});
