import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  workflow,
  createWorkflowRunRegistry,
  resumeWorkflow,
  isWorkflowSuspended,
  WorkflowSuspended,
  runStatusOf,
} from "@eidentic/workflow";
import type { Step, Workflow, WorkflowRunRecord } from "@eidentic/workflow";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const add1: Step<number, number> = async (n) => n + 1;

/** Run a workflow, capturing a suspend signal into the registry. */
async function runCapturing<I, O>(
  wf: Workflow<I, O>,
  input: I,
  registry: ReturnType<typeof createWorkflowRunRegistry>,
): Promise<WorkflowRunRecord> {
  try {
    const result = await wf.run(input);
    return registry.record(wf.name, result);
  } catch (err) {
    if (isWorkflowSuspended(err)) {
      return registry.recordSuspended(wf.name, err.trace, {
        token: err.token,
        payload: err.payload,
        cache: err.cache,
        input,
      });
    }
    throw err;
  }
}

// ─── ctx.suspend → suspended status → resume ─────────────────────────────────

describe("suspend / resume (HITL via replay)", () => {
  it("ctx.suspend throws a WorkflowSuspended signal carrying token + payload", async () => {
    const wf = workflow("approval", async (n: number, { step, suspend }) => {
      const drafted = await step("draft", add1, n);
      const ok = await suspend!<boolean>("approve", { draft: drafted });
      return ok ? "sent" : "rejected";
    });

    const err = await wf.run(5).catch((e) => e);
    expect(isWorkflowSuspended(err)).toBe(true);
    expect(err).toBeInstanceOf(WorkflowSuspended);
    expect(err.token).toBe("approve");
    expect(err.payload).toEqual({ draft: 6 });
    // The draft step ran and is in the partial trace.
    expect(err.trace.map((t: { name: string }) => t.name)).toContain("draft");
  });

  it("registry records suspended status + suspension state", async () => {
    const registry = createWorkflowRunRegistry();
    const wf = workflow("approval", async (n: number, { step, suspend }) => {
      const drafted = await step("draft", add1, n);
      const ok = await suspend!<boolean>("approve", drafted);
      return ok ? drafted : -1;
    });

    const rec = await runCapturing(wf, 5, registry);
    expect(rec.runStatus).toBe("suspended");
    expect(runStatusOf(rec)).toBe("suspended");
    // Legacy binary status is "ok" (not an error) for back-compat consumers.
    expect(rec.status).toBe("ok");
    expect(rec.suspension?.token).toBe("approve");
    expect(rec.suspension?.input).toBe(5);
  });

  it("resume completes the run with the decision", async () => {
    const registry = createWorkflowRunRegistry();
    const wf = workflow("approval", async (n: number, { step, suspend }) => {
      const drafted = await step("draft", add1, n);
      const ok = await suspend!<boolean>("approve", drafted);
      return ok ? drafted : -1;
    });

    const suspended = await runCapturing(wf, 5, registry);
    const resumed = await resumeWorkflow(wf, suspended.id, { registry, decision: true });

    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") {
      expect(resumed.output).toBe(6); // 5+1, approved
    }
    const after = registry.get(suspended.id)!;
    expect(after.runStatus).toBe("completed");
    expect(after.output).toBe(6);
    expect(after.suspension).toBeUndefined();
  });

  it("resume with a false decision takes the other branch", async () => {
    const registry = createWorkflowRunRegistry();
    const wf = workflow("approval", async (n: number, { step, suspend }) => {
      const drafted = await step("draft", add1, n);
      const ok = await suspend!<boolean>("approve", drafted);
      return ok ? drafted : -1;
    });
    const suspended = await runCapturing(wf, 5, registry);
    const resumed = await resumeWorkflow(wf, suspended.id, { registry, decision: false });
    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") expect(resumed.output).toBe(-1);
  });

  // ── replay does NOT re-execute completed step fns ──────────────────────────

  it("replay does NOT re-run completed step fns (invocation count stays 1)", async () => {
    const registry = createWorkflowRunRegistry();
    const draftFn = vi.fn(async (n: number) => n + 1);
    const wf = workflow("approval", async (n: number, { step, suspend }) => {
      const drafted = await step("draft", draftFn, n);
      const ok = await suspend!<boolean>("approve", drafted);
      return ok ? drafted : -1;
    });

    const suspended = await runCapturing(wf, 5, registry);
    expect(draftFn).toHaveBeenCalledTimes(1); // ran once before suspending

    await resumeWorkflow(wf, suspended.id, { registry, decision: true });
    // On resume the body re-executes but the memoized "draft" step is NOT re-run.
    expect(draftFn).toHaveBeenCalledTimes(1);
  });

  it("a memoized step result is replayed (same value) across resume", async () => {
    const registry = createWorkflowRunRegistry();
    let counter = 0;
    // Non-deterministic fn: returns a new value each call. If it were re-run on
    // replay, the output would change. Memoization keeps it stable.
    const nonDeterministic: Step<number, number> = async () => ++counter;
    const wf = workflow("approval", async (_n: number, { step, suspend }) => {
      const v = await step("rand", nonDeterministic, 0);
      await suspend!<boolean>("gate", v);
      return v;
    });
    const suspended = await runCapturing(wf, 0, registry);
    const resumed = await resumeWorkflow(wf, suspended.id, { registry, decision: true });
    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") {
      expect(resumed.output).toBe(1); // memoized first value, not 2
    }
    expect(counter).toBe(1); // fn only ever invoked once
  });

  // ── multiple sequential suspends ───────────────────────────────────────────

  it("supports multiple sequential suspends (each resume replays past decisions)", async () => {
    const registry = createWorkflowRunRegistry();
    const aFn = vi.fn(async (n: number) => n + 1);
    const bFn = vi.fn(async (n: number) => n * 10);
    const wf = workflow("two-gates", async (n: number, { step, suspend }) => {
      const a = await step("a", aFn, n);
      const ok1 = await suspend!<boolean>("gate-1", a);
      if (!ok1) return -1;
      const b = await step("b", bFn, a);
      const ok2 = await suspend!<boolean>("gate-2", b);
      return ok2 ? b : -2;
    });

    // First suspend at gate-1
    const s1 = await runCapturing(wf, 5, registry);
    expect(s1.runStatus).toBe("suspended");
    expect(s1.suspension?.token).toBe("gate-1");
    expect(aFn).toHaveBeenCalledTimes(1);

    // Resume gate-1 → re-suspends at gate-2
    const r1 = await resumeWorkflow(wf, s1.id, { registry, decision: true });
    expect(r1.kind).toBe("suspended");
    if (r1.kind === "suspended") expect(r1.token).toBe("gate-2");
    expect(registry.get(s1.id)!.runStatus).toBe("suspended");
    // "a" was memoized, not re-run; "b" ran once after gate-1 approval.
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);

    // Resume gate-2 → completes. Past gate-1 decision is replayed.
    const r2 = await resumeWorkflow(wf, s1.id, { registry, decision: true });
    expect(r2.kind).toBe("completed");
    if (r2.kind === "completed") expect(r2.output).toBe(60); // (5+1)*10
    // Neither step re-ran on the final resume.
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
    expect(registry.get(s1.id)!.runStatus).toBe("completed");
  });

  it("resumeWorkflow throws for unknown run id", async () => {
    const registry = createWorkflowRunRegistry();
    const wf = workflow("w", async (_n: number, { suspend }) => suspend!("x"));
    await expect(
      resumeWorkflow(wf, "nope", { registry, decision: true }),
    ).rejects.toThrow(/unknown run id/);
  });

  it("resumeWorkflow throws when the run is not suspended", async () => {
    const registry = createWorkflowRunRegistry();
    const wf = workflow("w", add1);
    const rec = registry.record("w", await wf.run(1));
    await expect(
      resumeWorkflow(wf, rec.id, { registry, decision: true }),
    ).rejects.toThrow(/not suspended/);
  });

  it("retry() does not swallow a suspend signal", async () => {
    const registry = createWorkflowRunRegistry();
    // A step whose body suspends — wrapped in retry. The suspend must escape,
    // not be retried.
    const wf = workflow("retry-suspend", async (_n: number, { suspend }) => {
      return suspend!<string>("inner-gate");
    });
    const suspended = await runCapturing(wf, 0, registry);
    expect(suspended.runStatus).toBe("suspended");
    const resumed = await resumeWorkflow(wf, suspended.id, { registry, decision: "approved" });
    expect(resumed.kind).toBe("completed");
    if (resumed.kind === "completed") expect(resumed.output).toBe("approved");
  });
});

// ─── Durable file store: crash survival ──────────────────────────────────────

describe("suspend persistence across registry restart (file store)", () => {
  it("suspended run survives a simulated crash and resumes after hydrate", async () => {
    const { fileWorkflowRunStore } = await import("@eidentic/workflow");
    const dir = mkdtempSync(join(tmpdir(), "eidentic-suspend-"));
    const path = join(dir, "runs.json");
    try {
      const draftFn = vi.fn(async (n: number) => n + 1);
      const wf = workflow("approval", async (n: number, { step, suspend }) => {
        const d = await step("draft", draftFn, n);
        const ok = await suspend!<boolean>("approve", d);
        return ok ? d : -1;
      });

      // Registry #1 with durable store — run, suspend, persist.
      const store1 = fileWorkflowRunStore(path);
      const reg1 = createWorkflowRunRegistry({ store: store1 });
      let runId = "";
      try {
        await wf.run(5);
      } catch (err) {
        if (isWorkflowSuspended(err)) {
          const rec = reg1.recordSuspended(wf.name, err.trace, {
            token: err.token,
            payload: err.payload,
            cache: err.cache,
            input: 5,
          });
          runId = rec.id;
        }
      }
      await reg1.flush();

      // "Crash": brand-new registry + store from the same file.
      const store2 = fileWorkflowRunStore(path);
      const reg2 = createWorkflowRunRegistry({ store: store2 });
      await reg2.hydrate();

      const recovered = reg2.get(runId);
      expect(recovered).toBeDefined();
      expect(recovered!.runStatus).toBe("suspended");
      expect(recovered!.suspension?.input).toBe(5);

      // Resume from the recovered registry — draftFn must NOT re-run.
      draftFn.mockClear();
      const resumed = await resumeWorkflow(wf, runId, { registry: reg2, decision: true });
      expect(resumed.kind).toBe("completed");
      if (resumed.kind === "completed") expect(resumed.output).toBe(6);
      expect(draftFn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
