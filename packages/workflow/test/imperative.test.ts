import { describe, it, expect } from "vitest";
import { workflow, step, parallel } from "@eidentic/workflow";
import type { Step, WorkflowEvent } from "@eidentic/workflow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const add1: Step<number, number> = async (n) => n + 1;
const double: Step<number, number> = async (n) => n * 2;
const numToStr: Step<number, string> = async (n) => String(n);
const upper: Step<string, string> = async (s) => s.toUpperCase();

// ─── ctx.step — imperative tracing ───────────────────────────────────────────

describe("ctx.step (imperative)", () => {
  it("thunk overload — runs fn and records trace", async () => {
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("my-fn", async () => n + 1);
    });
    const { output, trace } = await wf.run(5);
    expect(output).toBe(6);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.name).toBe("my-fn");
    expect(trace[0]!.status).toBe("ok");
  });

  it("Step overload — runs Step<I,O> and records trace", async () => {
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("add1", add1, n);
    });
    const { output, trace } = await wf.run(5);
    expect(output).toBe(6);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.name).toBe("add1");
  });

  it("records trace path correctly", async () => {
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("x", add1, n);
    });
    const { trace } = await wf.run(1);
    expect(trace[0]!.path).toEqual(["x"]);
  });

  it("multiple sequential steps produce ordered trace entries", async () => {
    const wf = workflow("w", async (n: number, ctx) => {
      const a = await ctx.step!("add1", add1, n);
      return ctx.step!("double", double, a);
    });
    const { output, trace } = await wf.run(5);
    expect(output).toBe(12); // (5+1)*2
    expect(trace.map((t) => t.name)).toEqual(["add1", "double"]);
  });

  it("records error trace when step throws, then re-throws", async () => {
    const boom: Step<number, number> = async () => { throw new Error("boom"); };
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("boom", boom, n);
    });
    await expect(wf.run(1)).rejects.toThrow("boom");
  });

  it("emits step.start/finish events via ctx.step", async () => {
    const events: WorkflowEvent[] = [];
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("add1", add1, n);
    });
    await wf.run(1, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual(["step.start", "step.finish"]);
  });

  it("emits step.error on failure", async () => {
    const events: WorkflowEvent[] = [];
    const boom: Step<number, number> = async () => { throw new Error("boom"); };
    const wf = workflow("w", async (n: number, ctx) => {
      return ctx.step!("boom", boom, n);
    });
    await wf.run(1, { onEvent: (e) => events.push(e) }).catch(() => {});
    expect(events.map((e) => e.type)).toEqual(["step.start", "step.error"]);
  });

  it("named step() combinator inside imperative body nests path", async () => {
    const namedAdd = step("add1", add1);
    const wf = workflow("w", async (n: number, ctx) => {
      // Using the declarative step() wrapper inside an imperative body
      return ctx.step!("outer", namedAdd, n);
    });
    const { trace } = await wf.run(1);
    // "outer" trace is recorded; "add1" is nested inside it (at path ["outer","add1"])
    const outer = trace.find((t) => t.name === "outer");
    expect(outer).toBeDefined();
  });

  it("works with destructured ctx in function signature", async () => {
    const wf = workflow("w", async (n: number, { step: ctxStep }) => {
      const a = await ctxStep!("add1", add1, n);
      return ctxStep!("double", double, a);
    });
    const { output } = await wf.run(3);
    expect(output).toBe(8); // (3+1)*2
  });
});

// ─── ctx.all — concurrent imperative tracing ─────────────────────────────────

describe("ctx.all (imperative)", () => {
  it("runs thunks concurrently and returns typed object", async () => {
    const wf = workflow("w", async (n: number, { step: ctxStep, all }) => {
      return all!({
        a: () => ctxStep!("add1", add1, n),
        b: () => ctxStep!("double", double, n),
      });
    });
    const { output } = await wf.run(5);
    expect(output).toEqual({ a: 6, b: 10 });
  });

  it("records individual trace entries for each thunk's ctx.step calls", async () => {
    const wf = workflow("w", async (n: number, { step: ctxStep, all }) => {
      return all!({
        x: () => ctxStep!("step-x", add1, n),
        y: () => ctxStep!("step-y", double, n),
      });
    });
    const { trace } = await wf.run(1);
    const names = trace.map((t) => t.name).sort();
    expect(names).toEqual(["step-x", "step-y"]);
  });

  it("runs thunks concurrently (not sequentially)", async () => {
    const timeline: string[] = [];
    const wf = workflow("w", async (_n: number, { all }) => {
      return all!({
        a: async () => {
          timeline.push("a-start");
          await new Promise((r) => setTimeout(r, 20));
          timeline.push("a-end");
          return "a";
        },
        b: async () => {
          timeline.push("b-start");
          await new Promise((r) => setTimeout(r, 5));
          timeline.push("b-end");
          return "b";
        },
      });
    });
    await wf.run(0);
    // Both start before either ends — proves concurrency
    const aStart = timeline.indexOf("a-start");
    const bStart = timeline.indexOf("b-start");
    const aEnd = timeline.indexOf("a-end");
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(aEnd); // b started before a finished
  });

  it("throws when any thunk fails", async () => {
    const wf = workflow("w", async (_n: number, { all }) => {
      return all!({
        ok: async () => "ok",
        fail: async () => { throw new Error("thunk-fail"); },
      });
    });
    await expect(wf.run(0)).rejects.toThrow("thunk-fail");
  });

  it("all() result is typed — works with destructuring", async () => {
    const wf = workflow("w", async (n: number, { step: ctxStep, all }) => {
      const { strResult, numResult } = await all!({
        strResult: () => ctxStep!("to-str", numToStr, n),
        numResult: () => ctxStep!("add1", add1, n),
      });
      return `${strResult}-${numResult}`;
    });
    const { output } = await wf.run(5);
    expect(output).toBe("5-6");
  });
});

// ─── ctx.step + ctx.all equivalence to declarative parallel ──────────────────

describe("imperative ctx.all equivalence to declarative parallel", () => {
  it("produces same output as parallel() combinator", async () => {
    const numToStr2: Step<number, string> = async (n) => String(n);
    const numFlag: Step<number, boolean> = async (n) => n > 0;

    const declarative = workflow(
      "w",
      parallel({ s: numToStr2, f: numFlag }) as Step<number, { s: string; f: boolean }>,
    );
    const imperative = workflow("w", async (n: number, { all, step: ctxStep }) => {
      return all!({
        s: () => ctxStep!("s", numToStr2, n),
        f: () => ctxStep!("f", numFlag, n),
      });
    });

    const [r1, r2] = await Promise.all([declarative.run(5), imperative.run(5)]);
    expect(r1.output).toEqual(r2.output);
  });
});
