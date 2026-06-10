import { describe, it, expectTypeOf } from "vitest";
import { workflow } from "@eidentic/workflow";
import type { Step, StepContext, WorkflowResult, MapItemResult } from "@eidentic/workflow";

// ─── Shared step fixtures ─────────────────────────────────────────────────────

const numToStr: Step<number, string> = async (n) => String(n);
const strLen: Step<string, number> = async (s) => s.length;
const strFlag: Step<string, boolean> = async (s) => s.length > 0;
const double: Step<number, number> = async (n) => n * 2;
const add1: Step<number, number> = async (n) => n + 1;
const upper: Step<string, string> = async (s) => s.toUpperCase();

// ─── Fluent builder type inference ───────────────────────────────────────────

describe("WorkflowBuilder — type inference", () => {
  it("first step pins In and Cur", () => {
    const wf = workflow("w").step(numToStr);
    // run(input: number) → WorkflowResult<string>
    expectTypeOf(wf.run).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(wf.run).returns.resolves.toMatchTypeOf<WorkflowResult<string>>();
  });

  it("second step threads Cur through", () => {
    const wf = workflow("w").step(numToStr).step(strLen);
    expectTypeOf(wf.run).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(wf.run).returns.resolves.toMatchTypeOf<WorkflowResult<number>>();
  });

  it("three-step chain infers exactly", () => {
    const wf = workflow("w").step(numToStr).step(strLen).step(double);
    expectTypeOf(wf.run).parameter(0).toEqualTypeOf<number>();
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<number>();
  });

  it("named .step() overload preserves types", () => {
    const wf = workflow("w").step("to-str", numToStr).step("to-len", strLen);
    expectTypeOf(wf.run).parameter(0).toEqualTypeOf<number>();
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<number>();
  });

  it("branch infers Next from both arms (which must agree)", () => {
    const wf = workflow("w").branch(
      (n: number) => n > 0,
      add1,         // Step<number, number>
      double,       // Step<number, number>
    );
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<number>();
  });

  it("parallel infers typed object result — the triage pattern", () => {
    // The example from the spec: {summary: string; sentiment: string}
    const summarizer: Step<string, string> = async (s) => s;
    const sentiment: Step<string, string> = async (s) => s;
    const wf = workflow("triage")
      .step(numToStr)
      .parallel({ summary: summarizer, sentiment });
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<{ summary: string; sentiment: string }>();
  });

  it("parallel with heterogeneous output types infers correctly", () => {
    const wf = workflow("w").parallel({ len: strLen, flag: strFlag });
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<{ len: number; flag: boolean }>();
  });

  it("tap preserves Cur type unchanged", () => {
    const wf = workflow("w").step(numToStr).tap((_s: string) => {});
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<string>();
  });

  it("map infers O[] from E[] → O via inner step", () => {
    // Current must be E[] to call .map
    const wf = workflow("w")
      .step(async (_n: number) => [1, 2, 3] as number[])
      .map(numToStr);
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<string[]>();
  });

  it("map fail-fast (default / explicit) infers bare O[]", () => {
    const ff = workflow("w")
      .step(async (_n: number) => [1, 2, 3] as number[])
      .map(numToStr, { errorPolicy: "fail-fast" });
    type Out = Awaited<ReturnType<typeof ff.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<string[]>();

    // No opts is still fail-fast → O[].
    const noOpts = workflow("w")
      .step(async (_n: number) => [1, 2, 3] as number[])
      .map(numToStr, { concurrency: 2 });
    type Out2 = Awaited<ReturnType<typeof noOpts.run>>;
    expectTypeOf<Out2["output"]>().toEqualTypeOf<string[]>();
  });

  it("map collect mode infers MapItemResult<O>[] (distinct from fail-fast O[])", () => {
    const wf = workflow("w")
      .step(async (_n: number) => [1, 2, 3] as number[])
      .map(numToStr, { errorPolicy: "collect" });
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<MapItemResult<string>[]>();
    // Crucially NOT the fail-fast shape.
    expectTypeOf<Out["output"]>().not.toEqualTypeOf<string[]>();
  });

  it("per-step retry option type-checks on named .step()", () => {
    const wf = workflow("w").step("flaky", numToStr, {
      retry: { maxAttempts: 3, backoffMs: 10, shouldRetry: (e: unknown) => e instanceof Error },
    });
    type Out = Awaited<ReturnType<typeof wf.run>>;
    // Retry does not change the output type.
    expectTypeOf<Out["output"]>().toEqualTypeOf<string>();
  });

  it("rejects an unknown retry policy field at compile time", () => {
    // @ts-expect-error `maxAttempts` is required in the retry policy
    workflow("w").step("flaky", numToStr, { retry: { backoffMs: 5 } });
  });

  it("workflow(name, { version }) is accepted and returns a builder", () => {
    const wf = workflow("w", { version: "1.0.0" }).step(numToStr);
    expectTypeOf(wf.version).toEqualTypeOf<string | undefined>();
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<string>();
  });

  it(".map is only callable when Cur is an array", () => {
    // Cur = string (not an array) — .map must not be available on the right `this`
    // @ts-expect-error: .map requires Cur to be E[], but Cur is string here
    workflow("w").step(numToStr).map(double);
  });

  it("asStep() returns Step<In, Cur>", () => {
    const s = workflow("w").step(numToStr).step(strLen).asStep();
    expectTypeOf(s).toEqualTypeOf<Step<number, number>>();
  });
});

// ─── ctx.step / ctx.all type inference ───────────────────────────────────────

describe("ctx.step / ctx.all — type inference", () => {
  it("ctx.step thunk overload infers O from thunk return", () => {
    workflow("w", async (_n: number, ctx) => {
      const result = await ctx.step!("x", async () => "hello");
      expectTypeOf(result).toEqualTypeOf<string>();
      return result;
    });
  });

  it("ctx.step Step overload infers O from Step<I,O>", () => {
    workflow("w", async (n: number, ctx) => {
      const result = await ctx.step!("add1", add1, n);
      expectTypeOf(result).toEqualTypeOf<number>();
      return result;
    });
  });

  it("ctx.step Step overload infers string output from numToStr", () => {
    workflow("w", async (n: number, ctx) => {
      const result = await ctx.step!("to-str", numToStr, n);
      expectTypeOf(result).toEqualTypeOf<string>();
      return result;
    });
  });

  it("ctx.all infers typed object from thunks record", () => {
    workflow("w", async (n: number, ctx) => {
      const result = await ctx.all!({
        a: async () => n + 1,
        b: async () => String(n),
      });
      expectTypeOf(result).toEqualTypeOf<{ a: number; b: string }>();
      return result;
    });
  });

  it("ctx.all with ctx.step thunks infers correct types", () => {
    workflow("w", async (n: number, ctx) => {
      const result = await ctx.all!({
        num: () => ctx.step!("add1", add1, n),
        str: () => ctx.step!("to-str", numToStr, n),
      });
      expectTypeOf(result).toEqualTypeOf<{ num: number; str: string }>();
      return result;
    });
  });

  it("ctx.suspend<T> resolves to T", () => {
    workflow("w", async (_n: number, ctx) => {
      const decision = await ctx.suspend!<boolean>("approve", { draft: "x" });
      expectTypeOf(decision).toEqualTypeOf<boolean>();
      return decision;
    });
  });

  it("ctx.step accepts a trailing retry options object on the Step overload", () => {
    workflow("w", async (n: number, ctx) => {
      const result = await ctx.step!("add1", add1, n, { retry: { maxAttempts: 2 } });
      expectTypeOf(result).toEqualTypeOf<number>();
      return result;
    });
  });
});
