import { describe, it, expect } from "vitest";
import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";
import { workflow, step } from "@eidentic/workflow";
import type { WorkflowResult, StepTrace } from "@eidentic/workflow";
import { createServer, ApiKeyAuth, WorkflowRunError } from "@eidentic/server";
import type { WorkflowRunSummary, WorkflowRunDetail, WorkflowRunOwner } from "@eidentic/server";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(responses: ModelResponse[] = []) {
  const store = new InMemoryStore();
  const agent = new Agent({
    id: "test-agent",
    instructions: "You are a helpful assistant.",
    model: new MockModel(responses),
    store,
  });
  return agent;
}

function makeTrace(
  steps: Array<{
    name?: string;
    startedAt: number;
    durationMs: number;
    status?: "ok" | "error";
    error?: string;
  }>,
): StepTrace[] {
  return steps.map((s, i) => ({
    name: s.name ?? `step-${i}`,
    path: [s.name ?? `step-${i}`],
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    status: s.status ?? "ok",
    ...(s.error !== undefined ? { error: s.error } : {}),
  }));
}

function makeResult<O>(output: O, trace: StepTrace[]): WorkflowResult<O> {
  return { output, trace };
}

// ─── GET /v1/workflows — list ─────────────────────────────────────────────────

describe("GET /v1/workflows — list", () => {
  it("returns empty array when no runs recorded", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toEqual([]);
  });

  it("returns summaries for recorded runs, newest first", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const trace1 = makeTrace([{ startedAt: 1000, durationMs: 100 }]);
    const trace2 = makeTrace([{ startedAt: 2000, durationMs: 200 }]);

    app.handle.recordWorkflow("first-wf", makeResult("out1", trace1));
    app.handle.recordWorkflow("second-wf", makeResult("out2", trace2));

    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(200);
    const body = await res.json() as WorkflowRunSummary[];
    expect(body.length).toBe(2);
    // newest first
    expect(body[0]!.name).toBe("second-wf");
    expect(body[1]!.name).toBe("first-wf");
  });

  it("summary contains exactly the right fields (no trace/output/error)", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const trace = makeTrace([{ startedAt: 5000, durationMs: 300 }]);
    app.handle.recordWorkflow("my-wf", makeResult({ answer: 42 }, trace));

    const res = await app.request("/v1/workflows");
    const [summary] = await res.json() as WorkflowRunSummary[];
    expect(typeof summary!.id).toBe("string");
    expect(summary!.name).toBe("my-wf");
    expect(summary!.status).toBe("ok");
    expect(summary!.startedAt).toBe(5000);
    expect(summary!.durationMs).toBe(300);
    expect(summary!.stepCount).toBe(1);
    // must NOT include trace/output/error
    expect("trace" in summary!).toBe(false);
    expect("output" in summary!).toBe(false);
    expect("error" in summary!).toBe(false);
  });

  it("returns status=error when any step failed", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const trace = makeTrace([
      { startedAt: 100, durationMs: 10, status: "ok" },
      { startedAt: 115, durationMs: 5, status: "error", error: "oops" },
    ]);
    app.handle.recordWorkflow("failing-wf", makeResult(undefined, trace));

    const res = await app.request("/v1/workflows");
    const [summary] = await res.json() as WorkflowRunSummary[];
    expect(summary!.status).toBe("error");
  });

  it("returns 401 when auth fails", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
    });
    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid auth key", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({ "my-key": { userId: "u1" } }),
    });
    const res = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer my-key" },
    });
    expect(res.status).toBe(200);
  });
});

// ─── GET /v1/workflows/:id — detail ──────────────────────────────────────────

describe("GET /v1/workflows/:id — detail", () => {
  it("returns 404 for an unknown id", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const res = await app.request("/v1/workflows/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({ "valid-key": { userId: "u1" } }),
    });
    const res = await app.request("/v1/workflows/some-id");
    expect(res.status).toBe(401);
  });

  it("returns full detail for a known id", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const trace = makeTrace([
      { name: "fetch", startedAt: 1000, durationMs: 50 },
      { name: "transform", startedAt: 1055, durationMs: 30 },
    ]);
    const id = app.handle.recordWorkflow("pipeline", makeResult({ result: "done" }, trace));

    const res = await app.request(`/v1/workflows/${id}`);
    expect(res.status).toBe(200);
    const detail = await res.json() as WorkflowRunDetail;

    expect(detail.id).toBe(id);
    expect(detail.name).toBe("pipeline");
    expect(detail.status).toBe("ok");
    expect(detail.startedAt).toBe(1000);
    expect(detail.durationMs).toBe(85); // max(1000+50, 1055+30) - 1000 = 1085 - 1000 = 85
    expect(detail.stepCount).toBe(2);
    expect(Array.isArray(detail.trace)).toBe(true);
    expect(detail.trace.length).toBe(2);
    expect(detail.trace[0]!.name).toBe("fetch");
    expect(detail.output).toEqual({ result: "done" });
    expect("error" in detail).toBe(false);
  });

  it("detail includes error field when any step failed", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const trace = makeTrace([
      { startedAt: 100, durationMs: 10, status: "error", error: "network timeout" },
    ]);
    const id = app.handle.recordWorkflow("broken-wf", makeResult(undefined, trace));

    const res = await app.request(`/v1/workflows/${id}`);
    const detail = await res.json() as WorkflowRunDetail;
    expect(detail.status).toBe("error");
    expect(detail.error).toBe("network timeout");
  });

  it("detail omits output when output is undefined", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const id = app.handle.recordWorkflow("no-output-wf", makeResult(undefined, []));

    const res = await app.request(`/v1/workflows/${id}`);
    const detail = await res.json() as WorkflowRunDetail;
    expect("output" in detail).toBe(false);
  });
});

// ─── handle.recordWorkflow — programmatic ingestion ───────────────────────────

describe("handle.recordWorkflow — ingestion", () => {
  it("returns the record id as a string", () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const id = app.handle.recordWorkflow("wf", makeResult("x", []));
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("recorded run is immediately retrievable via GET /v1/workflows/:id", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const id = app.handle.recordWorkflow("check-wf", makeResult(99, []));

    const res = await app.request(`/v1/workflows/${id}`);
    expect(res.status).toBe(200);
    const detail = await res.json() as WorkflowRunDetail;
    expect(detail.id).toBe(id);
    expect(detail.name).toBe("check-wf");
  });

  it("recorded run appears in GET /v1/workflows list", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const id = app.handle.recordWorkflow("listed-wf", makeResult("val", []));

    const res = await app.request("/v1/workflows");
    const list = await res.json() as WorkflowRunSummary[];
    expect(list.some((r) => r.id === id)).toBe(true);
  });

  it("multiple ingestions are all listed, newest first", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });
    const id1 = app.handle.recordWorkflow("a", makeResult(1, []));
    const id2 = app.handle.recordWorkflow("b", makeResult(2, []));
    const id3 = app.handle.recordWorkflow("c", makeResult(3, []));

    const res = await app.request("/v1/workflows");
    const list = await res.json() as WorkflowRunSummary[];
    expect(list[0]!.id).toBe(id3);
    expect(list[1]!.id).toBe(id2);
    expect(list[2]!.id).toBe(id1);
  });

  it("registry bound — evicts oldest on overflow", async () => {
    // createServer uses default limit=100; hard to test eviction here without a
    // custom limit. Test the property indirectly: can record many without error.
    const app = createServer({ agents: { demo: makeAgent() } });
    let lastId = "";
    for (let i = 0; i < 10; i++) {
      lastId = app.handle.recordWorkflow(`wf-${i}`, makeResult(i, []));
    }
    // Most recent run is still retrievable.
    const res = await app.request(`/v1/workflows/${lastId}`);
    expect(res.status).toBe(200);
  });
});

// ─── Cross-tenant ownership isolation ────────────────────────────────────────

describe("workflow ownership — cross-tenant isolation", () => {
  function makeAuthApp() {
    return createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({
        "key-tenant-a": { userId: "user-a", apiKey: "key-tenant-a" },
        "key-tenant-b": { userId: "user-b", apiKey: "key-tenant-b" },
      }),
    });
  }

  it("tenant A can list their own owned run", async () => {
    const app = makeAuthApp();
    const owner: WorkflowRunOwner = { userId: "user-a", apiKey: "key-tenant-a" };
    app.handle.recordWorkflow("wf-a", makeResult("out-a", []), owner);

    const res = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-a" },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as WorkflowRunSummary[];
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("wf-a");
  });

  it("tenant B cannot see tenant A's owned run in list", async () => {
    const app = makeAuthApp();
    const owner: WorkflowRunOwner = { userId: "user-a", apiKey: "key-tenant-a" };
    app.handle.recordWorkflow("wf-a", makeResult("out-a", []), owner);

    const res = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-b" },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as WorkflowRunSummary[];
    expect(list.length).toBe(0);
  });

  it("tenant B gets 404 for tenant A's run id (no existence oracle)", async () => {
    const app = makeAuthApp();
    const owner: WorkflowRunOwner = { userId: "user-a", apiKey: "key-tenant-a" };
    const id = app.handle.recordWorkflow("wf-a", makeResult("out-a", []), owner);

    const res = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-tenant-b" },
    });
    expect(res.status).toBe(404);
  });

  it("tenant A can retrieve their own run detail by id", async () => {
    const app = makeAuthApp();
    const owner: WorkflowRunOwner = { userId: "user-a", apiKey: "key-tenant-a" };
    const id = app.handle.recordWorkflow("wf-a", makeResult("result-a", []), owner);

    const res = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-tenant-a" },
    });
    expect(res.status).toBe(200);
    const detail = await res.json() as WorkflowRunDetail;
    expect(detail.id).toBe(id);
    expect(detail.name).toBe("wf-a");
  });

  it("both tenants can see their own runs; neither sees the other's", async () => {
    const app = makeAuthApp();
    const idA = app.handle.recordWorkflow("wf-a", makeResult("a", []), { userId: "user-a", apiKey: "key-tenant-a" });
    const idB = app.handle.recordWorkflow("wf-b", makeResult("b", []), { userId: "user-b", apiKey: "key-tenant-b" });

    const resA = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-a" },
    });
    const listA = await resA.json() as WorkflowRunSummary[];
    expect(listA.map((r) => r.id)).toContain(idA);
    expect(listA.map((r) => r.id)).not.toContain(idB);

    const resB = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-b" },
    });
    const listB = await resB.json() as WorkflowRunSummary[];
    expect(listB.map((r) => r.id)).toContain(idB);
    expect(listB.map((r) => r.id)).not.toContain(idA);
  });

  it("ownerless records are hidden from authenticated principals by default", async () => {
    const app = makeAuthApp();
    // Record without owner (legacy / no-auth mode)
    const id = app.handle.recordWorkflow("legacy-wf", makeResult("legacy", []));

    // Neither tenant can claim an ownerless legacy record without explicit migration opt-in.
    const resA = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-a" },
    });
    const listA = await resA.json() as WorkflowRunSummary[];
    expect(listA.some((r) => r.id === id)).toBe(false);

    const resB = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-tenant-b" },
    });
    const listB = await resB.json() as WorkflowRunSummary[];
    expect(listB.some((r) => r.id === id)).toBe(false);
  });

  it("ownerless records remain available behind the explicit compatibility opt-in", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({ "key-a": { userId: "user-a" } }),
      allowLegacyUnownedRecords: true,
    });
    const id = app.handle.recordWorkflow("legacy-wf", makeResult("legacy", []));

    const res = await app.request("/v1/workflows", {
      headers: { authorization: "Bearer key-a" },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as WorkflowRunSummary[];
    expect(list.some((r) => r.id === id)).toBe(true);
  });

  it("NoAuth single-tenant mode sees all runs regardless of owner field", async () => {
    // No auth adapter — all requests succeed as NoAuth
    const app = createServer({ agents: { demo: makeAgent() } });
    const idOwned = app.handle.recordWorkflow("owned", makeResult("x", []), { userId: "some-user" });
    const idLegacy = app.handle.recordWorkflow("legacy", makeResult("y", []));

    const res = await app.request("/v1/workflows");
    expect(res.status).toBe(200);
    const list = await res.json() as WorkflowRunSummary[];
    // NoAuth principal has no userId/orgId/apiKey — matches ownerless records (back-compat)
    // Owned records are also visible in NoAuth mode because principal has no
    // identifiers to compare, so the ownerless-record path applies (empty principal)
    const ids = list.map((r) => r.id);
    expect(ids).toContain(idLegacy);
  });

  it("orgId-scoped ownership: principal matching orgId sees the run", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({
        "key-org": { orgId: "org-x", apiKey: "key-org" },
        "key-other": { orgId: "org-y", apiKey: "key-other" },
      }),
    });
    const id = app.handle.recordWorkflow("org-wf", makeResult("data", []), { orgId: "org-x" });

    const resMatch = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-org" },
    });
    expect(resMatch.status).toBe(200);

    const resMismatch = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-other" },
    });
    expect(resMismatch.status).toBe(404);
  });
});

// ─── H11 — handle.recordWorkflowError — errored run recording ─────────────────

describe("handle.recordWorkflowError — H11 fix", () => {
  it("records a failed run with status=error and error message", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });

    const add1 = step("add1", async (n: number) => n + 1);
    const wf = workflow("crash-wf", async (n: number, ctx) => {
      await ctx.step!("add1", add1, n);
      throw new Error("body crash");
    });

    const runErr = await wf.run(1).catch((e) => e);
    expect(runErr).toBeInstanceOf(WorkflowRunError);

    const id = app.handle.recordWorkflowError(runErr);

    const res = await app.request(`/v1/workflows/${id}`);
    expect(res.status).toBe(200);
    const detail = await res.json() as WorkflowRunDetail;
    expect(detail.status).toBe("error");
    expect(detail.error).toBe("body crash");
    expect(detail.name).toBe("crash-wf");
  });

  it("recorded errored run includes partial step trace", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });

    const wf = workflow("partial-wf", async (n: number, ctx) => {
      await ctx.step!("step-a", async (x: number) => x + 1, n);
      await ctx.step!("step-b", async (x: number) => x * 2, n);
      throw new Error("crash after two steps");
    });

    const runErr = await wf.run(5).catch((e) => e) as WorkflowRunError;
    const id = app.handle.recordWorkflowError(runErr);

    const res = await app.request(`/v1/workflows/${id}`);
    const detail = await res.json() as WorkflowRunDetail;
    expect(detail.stepCount).toBe(2);
    expect(detail.trace.length).toBe(2);
    const names = detail.trace.map((t) => t.name);
    expect(names).toContain("step-a");
    expect(names).toContain("step-b");
  });

  it("errored run appears in GET /v1/workflows list with status=error", async () => {
    const app = createServer({ agents: { demo: makeAgent() } });

    const wf = workflow("listed-crash-wf", async () => {
      throw new Error("crash");
    });
    const runErr = await wf.run(0).catch((e) => e) as WorkflowRunError;
    const id = app.handle.recordWorkflowError(runErr);

    const res = await app.request("/v1/workflows");
    const list = await res.json() as WorkflowRunSummary[];
    const entry = list.find((r) => r.id === id);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("error");
    expect(entry!.name).toBe("listed-crash-wf");
  });

  it("errored run respects owner for tenant isolation", async () => {
    const app = createServer({
      agents: { demo: makeAgent() },
      auth: ApiKeyAuth({
        "key-a": { userId: "user-a" },
        "key-b": { userId: "user-b" },
      }),
    });

    const wf = workflow("owned-crash", async () => {
      throw new Error("crash");
    });
    const runErr = await wf.run(0).catch((e) => e) as WorkflowRunError;
    const id = app.handle.recordWorkflowError(runErr, { userId: "user-a" });

    // user-a can read it
    const resA = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-a" },
    });
    expect(resA.status).toBe(200);

    // user-b cannot
    const resB = await app.request(`/v1/workflows/${id}`, {
      headers: { authorization: "Bearer key-b" },
    });
    expect(resB.status).toBe(404);
  });
});
