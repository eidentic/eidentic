/**
 * Studio static-serve smoke test.
 *
 * We test the combined app (createStudio) by asserting that:
 *   1. /api/health returns 200 { ok: true }
 *   2. The studio API routes coexist alongside run routes
 *
 * We do NOT bind a real socket in this test — we use app.request() instead.
 * For static-serve smoke testing we verify that serveStudio is exported and
 * has the correct signature; actually running vite build in test time is not
 * done here (too slow). Instead, a separate build step produces ui/dist.
 */

import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createStudio, createStudioApi, serveStudio, StudioServeOptions } from "@eidentic/studio";
import type { ModelResponse } from "@eidentic/types";

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const AGENT_ID = "serve-test-agent";

async function makeAgent() {
  const store = new InMemoryStore();
  await store.migrate();
  return new Agent({
    id: AGENT_ID,
    instructions: "test",
    model: new MockModel([textResponse("hello")]),
    store,
  });
}

// ---------------------------------------------------------------------------
// Combined app: static + api coexist
// ---------------------------------------------------------------------------

describe("createStudio — combined app", () => {
  it("GET /api/health returns { ok: true }", async () => {
    const agent = await makeAgent();
    const app = createStudio({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /api/agents returns agent list", async () => {
    const agent = await makeAgent();
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/agents");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list.some((a) => a.id === AGENT_ID)).toBe(true);
  });

  it("run route and studio api coexist (health on /api/health + 404 on missing agent)", async () => {
    const agent = await makeAgent();
    const app = createStudio({ agents: { [AGENT_ID]: agent } });

    // Studio health
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);

    // Unknown agent
    const miss = await app.request("/api/agents/no-such-agent/blocks");
    expect(miss.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// serveStudio export contract
// ---------------------------------------------------------------------------

describe("serveStudio export", () => {
  it("is exported as a function", () => {
    expect(typeof serveStudio).toBe("function");
  });

  it("StudioServeOptions type is re-exported (compile-time check)", () => {
    // This just ensures the type is importable and usable
    const opts: StudioServeOptions = { agents: {} };
    expect(typeof opts).toBe("object");
  });
});
