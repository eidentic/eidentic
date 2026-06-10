import { describe, it, expect, vi } from "vitest";
import { workflow, map, createWorkflowRunRegistry } from "@eidentic/workflow";
import type { Step, MapItemResult } from "@eidentic/workflow";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const add1: Step<number, number> = async (n) => n + 1;
const double: Step<number, number> = async (n) => n * 2;

// ─── Per-step retry policy (builder) ─────────────────────────────────────────

describe("per-step retry policy", () => {
  it("builder .step(name, fn, { retry }) retries until success", async () => {
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      if (++attempts < 3) throw new Error("transient");
      return n + 1;
    };
    const wf = workflow("w").step("flaky", flaky, { retry: { maxAttempts: 3 } });
    const { output } = await wf.run(5);
    expect(output).toBe(6);
    expect(attempts).toBe(3);
  });

  it("attempts count is surfaced on the trace entry", async () => {
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      if (++attempts < 3) throw new Error("transient");
      return n;
    };
    const wf = workflow("w").step("flaky", flaky, { retry: { maxAttempts: 5 } });
    const { trace } = await wf.run(1);
    const entry = trace.find((t) => t.name === "flaky")!;
    expect(entry.attempts).toBe(3);
    expect(entry.status).toBe("ok");
  });

  it("single-attempt steps have NO attempts field (back-compat)", async () => {
    const wf = workflow("w").step("plain", add1);
    const { trace } = await wf.run(1);
    const entry = trace.find((t) => t.name === "plain")!;
    expect("attempts" in entry).toBe(false);
  });

  it("retry policy honors shouldRetry", async () => {
    let attempts = 0;
    const flaky: Step<number, number> = async () => {
      attempts++;
      throw new Error(attempts < 2 ? "retryable" : "permanent");
    };
    const wf = workflow("w").step("flaky", flaky, {
      retry: { maxAttempts: 5, shouldRetry: (e) => e instanceof Error && e.message === "retryable" },
    });
    await expect(wf.run(1)).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it("imperative ctx.step supports the same retry option", async () => {
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      if (++attempts < 2) throw new Error("transient");
      return n + 10;
    };
    const wf = workflow("w", async (n: number, { step }) => {
      return step!("flaky", flaky, n, { retry: { maxAttempts: 3 } });
    });
    const { output, trace } = await wf.run(5);
    expect(output).toBe(15);
    expect(attempts).toBe(2);
    expect(trace.find((t) => t.name === "flaky")!.attempts).toBe(2);
  });

  it("imperative ctx.step thunk overload + retry (opts in 3rd position)", async () => {
    let attempts = 0;
    const wf = workflow("w", async (_n: number, { step }) => {
      return step!(
        "thunk",
        async () => {
          if (++attempts < 2) throw new Error("transient");
          return "done";
        },
        { retry: { maxAttempts: 3 } },
      );
    });
    const { output } = await wf.run(0);
    expect(output).toBe("done");
    expect(attempts).toBe(2);
  });

  it("thunk overload still works WITHOUT opts (back-compat)", async () => {
    const wf = workflow("w", async (n: number, { step }) => {
      return step!("t", async () => n + 1);
    });
    expect((await wf.run(5)).output).toBe(6);
  });
});

// ─── Workflow version ─────────────────────────────────────────────────────────

describe("workflow version", () => {
  it("builder workflow(name, { version }) exposes version", () => {
    const wf = workflow("w", { version: "2.1.0" }).step(add1);
    expect(wf.version).toBe("2.1.0");
  });

  it("imperative workflow(name, body, { version }) exposes version", () => {
    const wf = workflow("w", add1, { version: "3.0.0" });
    expect(wf.version).toBe("3.0.0");
  });

  it("version is undefined when not provided (back-compat)", () => {
    const wf = workflow("w").step(add1);
    expect(wf.version).toBeUndefined();
  });

  it("version is recorded on the registry record and filterable", () => {
    const reg = createWorkflowRunRegistry();
    reg.record("w", { output: 1, trace: [] }, undefined, { version: "1.2.3" });
    const rec = reg.list()[0]!;
    expect(rec.version).toBe("1.2.3");
    expect(reg.list({ version: "1.2.3" })).toHaveLength(1);
    expect(reg.list({ version: "9.9.9" })).toHaveLength(0);
  });
});

// ─── map collect mode ─────────────────────────────────────────────────────────

describe("map() collect mode", () => {
  const ctx = { signal: undefined as AbortSignal | undefined, path: [] as readonly string[], emit: () => {} };

  it("default fail-fast mode unchanged: returns bare O[]", async () => {
    const result = await map(double)([1, 2, 3], ctx);
    expect(result).toEqual([2, 4, 6]);
  });

  it("collect mode gathers ALL results, discriminated by ok", async () => {
    const failEven: Step<number, number> = async (n) => {
      if (n % 2 === 0) throw new Error(`even-${n}`);
      return n * 10;
    };
    const results = await map(failEven, { errorPolicy: "collect" })([1, 2, 3, 4], ctx);
    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]!.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 30 });
    expect(results[3]!.ok).toBe(false);
    if (!results[1]!.ok) expect((results[1]!.error as Error).message).toBe("even-2");
  });

  it("collect mode runs EVERY item even when some fail (no short-circuit)", async () => {
    const seen: number[] = [];
    const failAll: Step<number, number> = async (n) => {
      seen.push(n);
      throw new Error(`fail-${n}`);
    };
    const results = await map(failAll, { errorPolicy: "collect", concurrency: 1 })([0, 1, 2], ctx);
    expect(seen.sort()).toEqual([0, 1, 2]); // all ran despite failures
    expect(results.every((r) => r.ok === false)).toBe(true);
  });

  it("collect mode preserves order", async () => {
    const slowFirst: Step<number, number> = async (n) => {
      await new Promise((r) => setTimeout(r, n === 0 ? 20 : 1));
      return n;
    };
    const results = await map(slowFirst, { errorPolicy: "collect", concurrency: 4 })([0, 1, 2], ctx);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual([0, 1, 2]);
  });

  it("collect mode in the builder threads MapItemResult<O>[]", async () => {
    const failEven: Step<number, number> = async (n) => {
      if (n % 2 === 0) throw new Error("e");
      return n;
    };
    const wf = workflow("w")
      .step(async (_n: number) => [1, 2, 3] as number[])
      .map(failEven, { errorPolicy: "collect" });
    const { output } = await wf.run(0);
    const results: MapItemResult<number>[] = output;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]!.ok).toBe(false);
  });

  it("empty input → empty result in both modes", async () => {
    expect(await map(double)([], ctx)).toEqual([]);
    expect(await map(double, { errorPolicy: "collect" })([], ctx)).toEqual([]);
  });
});
