/**
 * Tests for correctness fixes:
 *   (a) H11 — WorkflowRunError: run() with throwing body captures partial trace
 *   (b) H12 — MapError: map() with multiple concurrent failures collects all
 *   (c) M19 — ctx.all abort: signal propagation and pre-abort rejection
 *   (d) M20 — withTimeout listener leak: no accumulation under one parent signal
 */

import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import {
  workflow,
  step,
  map,
  withTimeout,
  WorkflowRunError,
  MapError,
} from "@eidentic/workflow";
import type { Step } from "@eidentic/workflow";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const add1: Step<number, number> = async (n) => n + 1;
const double: Step<number, number> = async (n) => n * 2;

// ─── (a) H11 — WorkflowRunError ───────────────────────────────────────────────

describe("H11 — WorkflowRunError: failed runs with partial trace", () => {
  it("run() wraps a throwing body in WorkflowRunError", async () => {
    const wf = workflow("boom-wf", async () => {
      throw new Error("body exploded");
    });
    const err = await wf.run(0).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    expect(err.workflowName).toBe("boom-wf");
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("body exploded");
  });

  it("WorkflowRunError.trace contains steps completed before the crash", async () => {
    const wf = workflow("partial-wf", async (n: number, ctx) => {
      await ctx.step!("step-a", add1, n);
      await ctx.step!("step-b", double, n + 1);
      throw new Error("crash after two steps");
    });
    const err = await wf.run(1).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    const names = err.trace.map((t: { name: string }) => t.name);
    expect(names).toContain("step-a");
    expect(names).toContain("step-b");
    // The partial trace should have both completed steps
    expect(err.trace.length).toBe(2);
    expect(err.trace[0].status).toBe("ok");
    expect(err.trace[1].status).toBe("ok");
  });

  it("WorkflowRunError.trace is empty when body throws before any step", async () => {
    const wf = workflow("immediate-boom", async () => {
      throw new Error("immediate");
    });
    const err = await wf.run(0).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    expect(err.trace).toHaveLength(0);
  });

  it("WorkflowRunError error message includes the workflow name and original message", () => {
    const wf = workflow("my-pipeline", async () => {
      throw new Error("network timeout");
    });
    return wf.run(0).catch((err: WorkflowRunError) => {
      expect(err.message).toContain("my-pipeline");
      expect(err.message).toContain("network timeout");
    });
  });

  it("WorkflowRunError includes a step trace entry marked error when a named step throws", async () => {
    const boom: Step<number, number> = async () => { throw new Error("step-boom"); };
    const wf = workflow("wf", async (n: number, ctx) => {
      await ctx.step!("ok-step", add1, n);
      await ctx.step!("fail-step", boom, n);
    });
    const err = await wf.run(1).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    // Both steps should be in the partial trace
    const failTrace = err.trace.find((t: { name: string }) => t.name === "fail-step");
    expect(failTrace).toBeDefined();
    expect(failTrace.status).toBe("error");
  });
});

// ─── (b) H12 — MapError: composite map failures ───────────────────────────────

describe("H12 — MapError: map() collects all concurrent failures", () => {
  it("MapError carries errors from both failing workers simultaneously", async () => {
    // Use concurrency=2 so both items run concurrently and both can fail
    const failAll: Step<number, number> = async (n) => {
      await new Promise((r) => setTimeout(r, 10)); // give time for both to start
      throw new Error(`fail-${n}`);
    };

    const ctx = {
      signal: undefined as AbortSignal | undefined,
      path: [] as readonly string[],
      emit: () => {},
    };

    const err = await map(failAll, { concurrency: 2 })([1, 2], ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MapError);
    expect(err.errors.length).toBe(2);

    const indices = err.errors.map((e: { index: number }) => e.index).sort();
    expect(indices).toEqual([0, 1]);

    const messages = err.errors.map((e: { error: unknown }) =>
      e.error instanceof Error ? e.error.message : String(e.error),
    );
    expect(messages).toContain("fail-1");
    expect(messages).toContain("fail-2");
  });

  it("MapError.cause is the first (by index) failure's error", async () => {
    const failAll: Step<number, number> = async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error(`e-${n}`);
    };
    const ctx = {
      signal: undefined as AbortSignal | undefined,
      path: [] as readonly string[],
      emit: () => {},
    };
    const err = await map(failAll, { concurrency: 4 })([0, 1, 2, 3], ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MapError);
    // cause should be the first (lowest-index) error's cause
    const lowestIndex = err.errors.reduce(
      (min: number, e: { index: number }) => Math.min(min, e.index),
      Infinity,
    );
    const lowestError = err.errors.find((e: { index: number }) => e.index === lowestIndex);
    expect(err.cause).toBe(lowestError?.error);
  });

  it("MapError message lists the failed index", async () => {
    const ctx = {
      signal: undefined as AbortSignal | undefined,
      path: [] as readonly string[],
      emit: () => {},
    };
    const err = await map(
      async (n: number) => { if (n === 1) throw new Error("bad"); return n; },
      { concurrency: 2 },
    )([0, 1, 2], ctx).catch((e) => e);

    expect(err).toBeInstanceOf(MapError);
    expect(err.message).toMatch(/1/); // index 1 failed
  });

  it("single-worker concurrency: only one worker runs at a time, first failure stops further work", async () => {
    const processed: number[] = [];
    const failOn1: Step<number, number> = async (n) => {
      processed.push(n);
      if (n === 1) throw new Error("fail-at-1");
      return n;
    };
    const ctx = {
      signal: undefined as AbortSignal | undefined,
      path: [] as readonly string[],
      emit: () => {},
    };
    const err = await map(failOn1, { concurrency: 1 })([0, 1, 2, 3], ctx).catch((e) => e);
    expect(err).toBeInstanceOf(MapError);
    // Items 2 and 3 should not have been processed (fail-fast)
    expect(processed).not.toContain(2);
    expect(processed).not.toContain(3);
  });
});

// ─── (c) M19 — ctx.all abort signal propagation ───────────────────────────────

describe("M19 — ctx.all respects abort signal", () => {
  it("rejects with abort error when signal is pre-aborted", async () => {
    const ac = new AbortController();
    ac.abort();

    const wf = workflow("abort-all-wf", async (_n: number, { all }) => {
      return all!({
        x: async () => "x",
        y: async () => "y",
      });
    });

    const err = await wf.run(0, { signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    // The cause should be an AbortError (or the wrapped abort error)
    const cause = err.cause;
    expect(
      cause instanceof Error && (cause.name === "AbortError" || (cause as NodeJS.ErrnoException).code === "ABORT_ERR"),
    ).toBe(true);
  });

  it("settles promptly with abort error when signal fires mid-flight", async () => {
    const ac = new AbortController();

    let started = false;
    const slow = async (): Promise<string> => {
      started = true;
      return new Promise((resolve) => setTimeout(() => resolve("done"), 500));
    };

    const wf = workflow("abort-mid-wf", async (_n: number, { all }) => {
      return all!({ slow });
    });

    // Abort after the thunk has started
    const runPromise = wf.run(0, { signal: ac.signal });
    // Give the thunk a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(true);
    ac.abort();

    const err = await runPromise.catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowRunError);
    const cause = err.cause;
    expect(
      cause instanceof Error && (cause.name === "AbortError" || (cause as NodeJS.ErrnoException).code === "ABORT_ERR"),
    ).toBe(true);
  });

  it("does not reject when signal is not aborted", async () => {
    const ac = new AbortController();
    const wf = workflow("no-abort-wf", async (n: number, { all }) => {
      return all!({
        a: async () => n + 1,
        b: async () => n * 2,
      });
    });
    const { output } = await wf.run(3, { signal: ac.signal });
    expect(output).toEqual({ a: 4, b: 6 });
  });
});

// ─── (d) M20 — withTimeout listener leak ─────────────────────────────────────

describe("M20 — withTimeout: no listener accumulation on parent signal", () => {
  it("listener count on parent signal does not grow after N sequential withTimeout calls", async () => {
    const ac = new AbortController();
    const signal = ac.signal;

    const fast: Step<number, number> = async (n) => n;
    const timedStep = step("timed", withTimeout(fast, 1000));

    // Run 20 sequential withTimeout-wrapped steps under the same signal
    const ctx = {
      signal,
      path: [] as readonly string[],
      _traces: [] as unknown[],
      emit: () => {},
    };

    for (let i = 0; i < 20; i++) {
      await timedStep(i, ctx as Parameters<typeof timedStep>[1]);
    }

    // Node.js exposes listener counts via getEventListeners from node:events
    const listeners = getEventListeners(signal, "abort");
    // Should be 0 (or at most 1 from other sources) — definitely not 20
    expect(listeners.length).toBeLessThanOrEqual(1);
  });

  it("no MaxListenersExceededWarning when running many withTimeout steps", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: NodeJS.ErrnoException) => {
      warnings.push(warning.message ?? String(warning));
    };
    process.on("warning", onWarning);

    const ac = new AbortController();
    const fast: Step<number, number> = async (n) => n;
    const ctx = {
      signal: ac.signal,
      path: [] as readonly string[],
      _traces: [] as unknown[],
      emit: () => {},
    };

    try {
      for (let i = 0; i < 30; i++) {
        await withTimeout(fast, 200)(i, ctx as Parameters<typeof fast>[1]);
      }
    } finally {
      process.off("warning", onWarning);
    }

    const maxListenerWarnings = warnings.filter((w) => w.includes("MaxListenersExceeded"));
    expect(maxListenerWarnings).toHaveLength(0);
  });
});
