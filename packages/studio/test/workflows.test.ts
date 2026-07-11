import { describe, it, expect, beforeEach } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import type { WorkflowResult, StepTrace } from "@eidentic/workflow";
import { createStudioApi, createStudio, ApiKeyAuth } from "@eidentic/studio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeTrace(steps: Array<{ name: string; path?: string[]; status?: "ok" | "error"; durationMs?: number; error?: string }>): StepTrace[] {
  let t = 1_000_000;
  return steps.map((s) => {
    const dur = s.durationMs ?? 100;
    const trace: StepTrace = {
      name: s.name,
      path: s.path ?? [s.name],
      startedAt: t,
      durationMs: dur,
      status: s.status ?? "ok",
    };
    if (s.error) trace.error = s.error;
    t += dur;
    return trace;
  });
}

function makeResult<O>(output: O, steps: Parameters<typeof makeTrace>[0]): WorkflowResult<O> {
  return { output, trace: makeTrace(steps) };
}

const AGENT_ID = "wf-test-agent";

let agent: Agent;

beforeEach(async () => {
  const store = new InMemoryStore();
  await store.migrate();
  agent = new Agent({
    id: AGENT_ID,
    instructions: "test",
    model: new MockModel([textResponse("ok")]),
    store,
  });
});

// ---------------------------------------------------------------------------
// Registry: record / list / detail
// ---------------------------------------------------------------------------

describe("workflow registry — programmatic recordWorkflow", () => {
  it("GET /api/workflows returns [] when empty", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("recordWorkflow adds a run and GET /api/workflows lists it", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const result = makeResult("done", [{ name: "step-a" }]);
    app.recordWorkflow("triage", result);

    const res = await app.request("/api/workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      status: string;
      stepCount: number;
      durationMs: number;
      startedAt: number;
    }>;
    expect(body).toHaveLength(1);
    const entry = body[0]!;
    expect(entry.name).toBe("triage");
    expect(entry.status).toBe("ok");
    expect(entry.stepCount).toBe(1);
    expect(typeof entry.durationMs).toBe("number");
    expect(typeof entry.startedAt).toBe("number");
  });

  it("GET /api/workflows/:id returns the full trace", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const result = makeResult({ answer: 42 }, [
      { name: "fetch" },
      { name: "process", durationMs: 250 },
    ]);
    app.recordWorkflow("enrich", result);

    // Get the id from the list first
    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ id: string }>;
    const { id } = list[0]!;

    const detailRes = await app.request(`/api/workflows/${id}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      id: string;
      name: string;
      status: string;
      trace: StepTrace[];
      output: unknown;
    };
    expect(detail.id).toBe(id);
    expect(detail.name).toBe("enrich");
    expect(detail.status).toBe("ok");
    expect(Array.isArray(detail.trace)).toBe(true);
    expect(detail.trace).toHaveLength(2);
    expect(detail.trace[0]!.name).toBe("fetch");
    expect(detail.trace[1]!.name).toBe("process");
    expect(detail.output).toEqual({ answer: 42 });
  });

  it("GET /api/workflows/:id returns 404 for unknown id", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/workflows/wr_does-not-exist");
    expect(res.status).toBe(404);
  });

  it("derives status=error when any step has status=error", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const result = makeResult(null, [
      { name: "step-ok" },
      { name: "step-fail", status: "error", error: "timeout" },
    ]);
    app.recordWorkflow("risky", result);

    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ status: string }>;
    expect(list[0]!.status).toBe("error");
  });

  it("derives status=ok when all steps succeed", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const result = makeResult("all good", [{ name: "a" }, { name: "b" }]);
    app.recordWorkflow("safe", result);

    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ status: string }>;
    expect(list[0]!.status).toBe("ok");
  });

  it("list returns newest run first", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    app.recordWorkflow("first", makeResult(1, [{ name: "s1" }]));
    app.recordWorkflow("second", makeResult(2, [{ name: "s2" }]));

    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list[0]!.name).toBe("second");
    expect(list[1]!.name).toBe("first");
  });

  it("registry is bounded to 100 runs; oldest run evicted", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    // Record 101 runs
    for (let i = 0; i < 101; i++) {
      app.recordWorkflow(`run-${i}`, makeResult(i, [{ name: "s" }]));
    }
    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list).toHaveLength(100);
    // run-0 is the oldest, should have been evicted
    expect(list.some((r) => r.name === "run-0")).toBe(false);
    // run-100 is the most recent and should be present (first in list)
    expect(list[0]!.name).toBe("run-100");
  });

  it("empty trace → status=ok, durationMs=0", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    app.recordWorkflow("empty", { output: null, trace: [] });
    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ status: string; durationMs: number; stepCount: number }>;
    expect(list[0]!.status).toBe("ok");
    expect(list[0]!.durationMs).toBe(0);
    expect(list[0]!.stepCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HTTP ingestion: POST /api/workflows
// ---------------------------------------------------------------------------

describe("POST /api/workflows — HTTP ingestion", () => {
  it("records a run and returns 201 with id/name/status", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const trace = makeTrace([{ name: "step-x" }]);
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "http-run", trace, output: "result" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; status: string };
    expect(body.name).toBe("http-run");
    expect(body.status).toBe("ok");
    expect(typeof body.id).toBe("string");

    // Also shows up in the list
    const listRes = await app.request("/api/workflows");
    const list = (await listRes.json()) as Array<{ name: string }>;
    expect(list.some((r) => r.name === "http-run")).toBe(true);
  });

  it("returns 400 on missing name", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trace: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing trace", async () => {
    const app = createStudioApi({ agents: { [AGENT_ID]: agent } });
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "oops" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/workflows is auth-gated (401 without credentials)", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const trace = makeTrace([{ name: "s" }]);
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "secured", trace }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/workflows succeeds with valid auth", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const trace = makeTrace([{ name: "s" }]);
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      body: JSON.stringify({ name: "secured", trace }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Auth gating on GET routes
// ---------------------------------------------------------------------------

describe("workflow GET routes — auth gating", () => {
  it("GET /api/workflows returns 401 without key when auth configured", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request("/api/workflows");
    expect(res.status).toBe(401);
  });

  it("GET /api/workflows/:id returns 401 without key when auth configured", async () => {
    const app = createStudioApi({
      agents: { [AGENT_ID]: agent },
      adminAuth: ApiKeyAuth({ "test-key": { userId: "u1" } }),
    });
    const res = await app.request("/api/workflows/wr_some-id");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// createStudio — recordWorkflow works on the combined handle
// ---------------------------------------------------------------------------

describe("createStudio — recordWorkflow on combined handle", () => {
  it("recordWorkflow on combined handle is reflected in GET /api/workflows", async () => {
    const app = createStudio({ agents: { [AGENT_ID]: agent } });
    const result = makeResult("combined", [{ name: "a" }, { name: "b" }]);
    app.recordWorkflow("combined-wf", result);

    const res = await app.request("/api/workflows");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; stepCount: number }>;
    expect(list.some((r) => r.name === "combined-wf" && r.stepCount === 2)).toBe(true);
  });
});
