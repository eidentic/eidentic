import { describe, it, expect } from "vitest";
import { createWorkflowRunRegistry } from "@eidentic/workflow";
import type { WorkflowResult, StepTrace, WorkflowRunOwner } from "@eidentic/workflow";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrace(steps: Array<{ startedAt: number; durationMs: number; status?: "ok" | "error"; error?: string }>): StepTrace[] {
  return steps.map((s, i) => ({
    name: `step-${i}`,
    path: [`step-${i}`],
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    status: s.status ?? "ok",
    ...(s.error !== undefined ? { error: s.error } : {}),
  }));
}

function makeResult<O>(output: O, trace: StepTrace[]): WorkflowResult<O> {
  return { output, trace };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createWorkflowRunRegistry", () => {
  describe("record — field derivation", () => {
    it("derives status=ok when all steps are ok", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 1000, durationMs: 50 },
        { startedAt: 1060, durationMs: 30 },
      ]);
      const rec = reg.record("my-workflow", makeResult("result", trace));
      expect(rec.status).toBe("ok");
    });

    it("derives status=error when any step has status=error", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 1000, durationMs: 20, status: "ok" },
        { startedAt: 1025, durationMs: 10, status: "error", error: "boom" },
      ]);
      const rec = reg.record("my-workflow", makeResult(undefined, trace));
      expect(rec.status).toBe("error");
    });

    it("derives startedAt as min(step.startedAt)", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 2000, durationMs: 100 },
        { startedAt: 1500, durationMs: 200 },
        { startedAt: 3000, durationMs: 50 },
      ]);
      const rec = reg.record("w", makeResult(null, trace));
      expect(rec.startedAt).toBe(1500);
    });

    it("derives durationMs as max(startedAt+durationMs) - min(startedAt)", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 1000, durationMs: 200 },  // ends at 1200
        { startedAt: 1050, durationMs: 500 },  // ends at 1550
        { startedAt: 1100, durationMs: 100 },  // ends at 1200
      ]);
      const rec = reg.record("w", makeResult(null, trace));
      // startedAt=1000, endAt=1550, durationMs=550
      expect(rec.startedAt).toBe(1000);
      expect(rec.durationMs).toBe(550);
    });

    it("derives stepCount = trace.length", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 100, durationMs: 10 },
        { startedAt: 115, durationMs: 10 },
        { startedAt: 130, durationMs: 10 },
      ]);
      const rec = reg.record("w", makeResult("x", trace));
      expect(rec.stepCount).toBe(3);
    });

    it("stores output when provided", () => {
      const reg = createWorkflowRunRegistry();
      const rec = reg.record("w", makeResult({ answer: 42 }, []));
      expect(rec.output).toEqual({ answer: 42 });
    });

    it("omits output key when output is undefined", () => {
      const reg = createWorkflowRunRegistry();
      const rec = reg.record("w", makeResult(undefined, []));
      expect("output" in rec).toBe(false);
    });

    it("stores error string from first errored step", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([
        { startedAt: 100, durationMs: 10, status: "error", error: "first error" },
        { startedAt: 120, durationMs: 10, status: "error", error: "second error" },
      ]);
      const rec = reg.record("w", makeResult(undefined, trace));
      expect(rec.error).toBe("first error");
    });

    it("omits error key when no step has status=error", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([{ startedAt: 100, durationMs: 10, status: "ok" }]);
      const rec = reg.record("w", makeResult("ok", trace));
      expect("error" in rec).toBe(false);
    });

    it("handles empty trace gracefully (startedAt=0, durationMs=0, stepCount=0)", () => {
      const reg = createWorkflowRunRegistry();
      const rec = reg.record("empty-wf", makeResult("done", []));
      expect(rec.startedAt).toBe(0);
      expect(rec.durationMs).toBe(0);
      expect(rec.stepCount).toBe(0);
      expect(rec.status).toBe("ok");
    });

    it("stores the full trace on the record", () => {
      const reg = createWorkflowRunRegistry();
      const trace = makeTrace([{ startedAt: 5000, durationMs: 100 }]);
      const rec = reg.record("w", makeResult("x", trace));
      expect(rec.trace).toEqual(trace);
    });

    it("generates a unique id for each record", () => {
      const reg = createWorkflowRunRegistry();
      const a = reg.record("w", makeResult("a", []));
      const b = reg.record("w", makeResult("b", []));
      expect(a.id).not.toBe(b.id);
      expect(typeof a.id).toBe("string");
      expect(a.id.length).toBeGreaterThan(0);
    });
  });

  describe("get", () => {
    it("returns the record for a known id", () => {
      const reg = createWorkflowRunRegistry();
      const rec = reg.record("w", makeResult("output", []));
      expect(reg.get(rec.id)).toBe(rec);
    });

    it("returns undefined for an unknown id", () => {
      const reg = createWorkflowRunRegistry();
      expect(reg.get("does-not-exist")).toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns an empty array when no records", () => {
      const reg = createWorkflowRunRegistry();
      expect(reg.list()).toEqual([]);
    });

    it("returns records newest first", () => {
      const reg = createWorkflowRunRegistry();
      const a = reg.record("a", makeResult(1, []));
      const b = reg.record("b", makeResult(2, []));
      const c = reg.record("c", makeResult(3, []));
      const list = reg.list();
      expect(list[0]!.id).toBe(c.id);
      expect(list[1]!.id).toBe(b.id);
      expect(list[2]!.id).toBe(a.id);
    });
  });

  describe("ring-buffer eviction", () => {
    it("evicts the oldest record when limit is reached", () => {
      const reg = createWorkflowRunRegistry({ limit: 3 });
      const a = reg.record("a", makeResult(1, []));
      const b = reg.record("b", makeResult(2, []));
      const c = reg.record("c", makeResult(3, []));
      const d = reg.record("d", makeResult(4, [])); // evicts a

      // a should be gone
      expect(reg.get(a.id)).toBeUndefined();
      // b, c, d should still be there
      expect(reg.get(b.id)).toBeDefined();
      expect(reg.get(c.id)).toBeDefined();
      expect(reg.get(d.id)).toBeDefined();
    });

    it("list length never exceeds the limit", () => {
      const limit = 5;
      const reg = createWorkflowRunRegistry({ limit });
      for (let i = 0; i < 12; i++) {
        reg.record(`w-${i}`, makeResult(i, []));
      }
      expect(reg.list().length).toBe(limit);
    });

    it("evicts in FIFO order (oldest first)", () => {
      const reg = createWorkflowRunRegistry({ limit: 2 });
      const a = reg.record("a", makeResult(1, []));
      const b = reg.record("b", makeResult(2, []));
      const c = reg.record("c", makeResult(3, [])); // evicts a

      expect(reg.get(a.id)).toBeUndefined();
      expect(reg.get(b.id)).toBeDefined();
      expect(reg.get(c.id)).toBeDefined();

      const d = reg.record("d", makeResult(4, [])); // evicts b
      expect(reg.get(b.id)).toBeUndefined();
      expect(reg.get(c.id)).toBeDefined();
      expect(reg.get(d.id)).toBeDefined();
    });
  });
});

// ─── Ownership ────────────────────────────────────────────────────────────────

describe("createWorkflowRunRegistry — ownership", () => {
  it("stores owner when provided", () => {
    const reg = createWorkflowRunRegistry();
    const owner: WorkflowRunOwner = { userId: "u1", orgId: "org1" };
    const rec = reg.record("w", makeResult("x", []), owner);
    expect(rec.owner).toEqual({ userId: "u1", orgId: "org1" });
  });

  it("omits owner field when not provided", () => {
    const reg = createWorkflowRunRegistry();
    const rec = reg.record("w", makeResult("x", []));
    expect("owner" in rec).toBe(false);
  });

  it("owner object is a defensive copy (not the same reference)", () => {
    const reg = createWorkflowRunRegistry();
    const owner: WorkflowRunOwner = { userId: "u1" };
    const rec = reg.record("w", makeResult("x", []), owner);
    owner.userId = "mutated";
    expect(rec.owner!.userId).toBe("u1");
  });

  it("apiKey-only owner is stored", () => {
    const reg = createWorkflowRunRegistry();
    const rec = reg.record("w", makeResult("x", []), { apiKey: "key-abc" });
    expect(rec.owner).toEqual({ apiKey: "key-abc" });
  });
});

// ─── ID format ────────────────────────────────────────────────────────────────

describe("createWorkflowRunRegistry — ID format", () => {
  it("generates a UUID v4 string for each record", () => {
    const reg = createWorkflowRunRegistry();
    const rec = reg.record("w", makeResult("x", []));
    // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(rec.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("every record gets a distinct UUID", () => {
    const reg = createWorkflowRunRegistry();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(reg.record("w", makeResult(i, [])).id);
    }
    expect(ids.size).toBe(20);
  });
});

// ─── Defensive trace copy ─────────────────────────────────────────────────────

describe("createWorkflowRunRegistry — defensive trace copy", () => {
  it("stored trace is not the same array reference as the input", () => {
    const reg = createWorkflowRunRegistry();
    const trace = makeTrace([{ startedAt: 1000, durationMs: 50 }]);
    const rec = reg.record("w", makeResult("x", trace));
    expect(rec.trace).not.toBe(trace);
    expect(rec.trace).toEqual(trace);
  });

  it("mutating the original trace does not affect the stored record", () => {
    const reg = createWorkflowRunRegistry();
    const trace = makeTrace([{ startedAt: 1000, durationMs: 50 }]);
    const rec = reg.record("w", makeResult("x", trace));
    // Mutate original
    trace[0]!.durationMs = 9999;
    // Stored copy is unchanged
    expect(rec.trace[0]!.durationMs).toBe(50);
  });

  it("stored trace items are defensive copies (not same references)", () => {
    const reg = createWorkflowRunRegistry();
    const trace = makeTrace([{ startedAt: 100, durationMs: 10 }]);
    const rec = reg.record("w", makeResult("x", trace));
    expect(rec.trace[0]).not.toBe(trace[0]);
  });
});
