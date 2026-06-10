import { describe, it, expect } from "vitest";
import { expectTypeOf } from "vitest";
import {
  workflow,
  step,
  chain,
  parallel,
  retry,
} from "@eidentic/workflow";
import type { Step, StepTrace, WorkflowEvent } from "@eidentic/workflow";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const add1: Step<number, number> = async (n) => n + 1;
const double: Step<number, number> = async (n) => n * 2;
const numToStr: Step<number, string> = async (n) => String(n);
const strLen: Step<string, number> = async (s) => s.length;
const strFlag: Step<string, boolean> = async (s) => s.length > 0;
const upper: Step<string, string> = async (s) => s.toUpperCase();

// ─── workflow(name) — fluent builder ─────────────────────────────────────────

describe("workflow(name) — fluent builder", () => {
  // ── basic step execution ──────────────────────────────────────────────────

  it("single step — run returns correct output", async () => {
    const wf = workflow("w").step(add1);
    const { output } = await wf.run(5);
    expect(output).toBe(6);
  });

  it("two chained steps — executes in order", async () => {
    const wf = workflow("w").step(numToStr).step(strLen);
    const { output } = await wf.run(123);
    expect(output).toBe(3); // "123".length
  });

  it("named step — appears in trace under that name", async () => {
    const wf = workflow("w").step("my-step", add1);
    const { trace } = await wf.run(1);
    expect(trace).toHaveLength(1);
    expect(trace[0]!.name).toBe("my-step");
    expect(trace[0]!.status).toBe("ok");
  });

  it("anonymous step — not in trace (no wrapping)", async () => {
    const wf = workflow("w").step(add1);
    const { trace } = await wf.run(1);
    // Unnamed step has no trace entry
    expect(trace).toHaveLength(0);
  });

  // ── named steps preserve trace structure ──────────────────────────────────

  it("two named steps — trace has both in order", async () => {
    const wf = workflow("pipe")
      .step("to-str", numToStr)
      .step("to-len", strLen);
    const { output, trace } = await wf.run(99);
    expect(output).toBe(2); // "99".length
    expect(trace.map((t) => t.name)).toEqual(["to-str", "to-len"]);
  });

  it("trace records correct path for named steps", async () => {
    const wf = workflow("w").step("a", add1).step("b", double);
    const { trace } = await wf.run(3);
    expect(trace[0]!.path).toEqual(["a"]);
    expect(trace[1]!.path).toEqual(["b"]);
  });

  // ── branch ────────────────────────────────────────────────────────────────

  it("branch — takes ifTrue arm when predicate is true", async () => {
    // WorkflowStart only has .step(); branch is on WorkflowBuilder after a first step
    const identity: Step<number, number> = async (n) => n;
    const wf = workflow("w").step(identity).branch((n: number) => n > 0, add1, double);
    expect((await wf.run(5)).output).toBe(6);  // add1
  });

  it("branch — takes ifFalse arm when predicate is false", async () => {
    const identity: Step<number, number> = async (n) => n;
    const wf = workflow("w").step(identity).branch((n: number) => n > 0, add1, double);
    expect((await wf.run(0)).output).toBe(0);  // double(0)
  });

  it("branch — supports async predicate", async () => {
    const identity: Step<number, number> = async (n) => n;
    const wf = workflow("w").step(identity).branch(async (n: number) => n > 10, add1, double);
    expect((await wf.run(20)).output).toBe(21);
  });

  it("branch — wrapping retry in ifFalse arm works", async () => {
    const identity: Step<number, number> = async (n) => n;
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      if (++attempts < 3) throw new Error("transient");
      return n + 100;
    };
    const wf = workflow("w").step(identity).branch(
      (n: number) => n > 100,
      add1,
      retry(flaky, { maxAttempts: 3 }),
    );
    const { output } = await wf.run(5);
    expect(output).toBe(105);
    expect(attempts).toBe(3);
  });

  // ── parallel ──────────────────────────────────────────────────────────────

  it("parallel — runs all steps on current value and returns typed object", async () => {
    const identity: Step<string, string> = async (s) => s;
    const wf = workflow("w").step(identity).parallel({ len: strLen, flag: strFlag });
    const { output } = await wf.run("hello");
    expect(output).toEqual({ len: 5, flag: true });
  });

  it("parallel — multiple concurrent steps all execute", async () => {
    const identity: Step<number, number> = async (n) => n;
    const executed: string[] = [];
    const a: Step<number, number> = async (n) => { executed.push("a"); return n + 1; };
    const b: Step<number, number> = async (n) => { executed.push("b"); return n * 2; };
    const wf = workflow("w").step(identity).parallel({ a, b });
    const { output } = await wf.run(3);
    expect(output.a).toBe(4);
    expect(output.b).toBe(6);
    expect(executed.sort()).toEqual(["a", "b"]);
  });

  // ── map ───────────────────────────────────────────────────────────────────

  it("map — maps over array and preserves order", async () => {
    const wf = workflow("w")
      .step(async (n: number) => [n, n + 1, n + 2] as number[])
      .map(double);
    const { output } = await wf.run(1);
    expect(output).toEqual([2, 4, 6]);
  });

  it("map — respects concurrency option", async () => {
    let peak = 0;
    let active = 0;
    const tracked: Step<number, number> = async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n;
    };
    const wf = workflow("w")
      .step(async (_n: number) => [1, 2, 3, 4, 5, 6] as number[])
      .map(tracked, { concurrency: 2 });
    await wf.run(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  // ── tap ───────────────────────────────────────────────────────────────────

  it("tap — passes through value unchanged", async () => {
    const sideEffects: number[] = [];
    const wf = workflow("w").step(add1).tap((n) => { sideEffects.push(n); });
    const { output } = await wf.run(5);
    expect(output).toBe(6);
    expect(sideEffects).toEqual([6]);
  });

  it("tap — awaits async side effects", async () => {
    const log: string[] = [];
    const wf = workflow("w")
      .step(numToStr)
      .tap(async (s) => { await new Promise((r) => setTimeout(r, 5)); log.push(s); });
    await wf.run(42);
    expect(log).toEqual(["42"]);
  });

  // ── signal propagation ────────────────────────────────────────────────────

  it("signal propagates through builder steps", async () => {
    const ac = new AbortController();
    const slow: Step<number, number> = async (n) => {
      ac.abort();
      return n;
    };
    const boom: Step<number, number> = async () => {
      throw new Error("should not reach");
    };
    const wf = workflow("w").step(slow).step(boom);
    await expect(wf.run(1, { signal: ac.signal })).rejects.toThrow();
  });

  // ── asStep() ─────────────────────────────────────────────────────────────

  it("asStep() nests builder into outer workflow with path nesting", async () => {
    const inner = workflow("inner")
      .step("x", add1)
      .step("y", double);

    const outer = workflow("outer", inner.asStep());
    const { trace } = await outer.run(3);
    expect(trace.map((t) => t.path)).toEqual([["inner", "x"], ["inner", "y"]]);
  });

  it("asStep() returns correct output", async () => {
    const inner = workflow("inner").step(numToStr).step(upper);
    const outer = workflow("outer", inner.asStep());
    const { output } = await outer.run(42);
    expect(output).toBe("42");
  });

  // ── build() ───────────────────────────────────────────────────────────────

  it("build() returns a Workflow with the same behaviour as run()", async () => {
    const builder = workflow("w").step(add1).step(double);
    const wf = builder.build();
    expect(wf.name).toBe("w");
    const { output } = await wf.run(5);
    expect(output).toBe(12); // (5+1)*2
  });

  // ── onEvent ───────────────────────────────────────────────────────────────

  it("onEvent receives step.start/finish for named steps", async () => {
    const events: WorkflowEvent[] = [];
    const wf = workflow("w").step("my-step", add1);
    await wf.run(1, { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual(["step.start", "step.finish"]);
    expect((events[0]! as { name: string }).name).toBe("my-step");
  });

  // ── type inference ────────────────────────────────────────────────────────

  it("infers correct output type through step chain", () => {
    const wf = workflow("w").step(numToStr).step(strLen);
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<number>();
  });

  it("parallel infers typed object result", () => {
    const identity: Step<string, string> = async (s) => s;
    const wf = workflow("w").step(identity).parallel({ len: strLen, flag: strFlag });
    type Out = Awaited<ReturnType<typeof wf.run>>;
    expectTypeOf<Out["output"]>().toEqualTypeOf<{ len: number; flag: boolean }>();
  });
});

// ─── Equivalence: functional ≡ fluent ≡ trace shape ──────────────────────────

describe("three-style equivalence — identical output AND trace structure", () => {
  // The same logical pipeline written in 3 styles:
  //   (1) functional:  workflow(name, chain(step("a",…), step("b",…)))
  //   (2) fluent:      workflow(name).step("a",…).step("b",…)
  //   (3) imperative:  workflow(name, async (n, ctx) => { await ctx.step("a",…); … })
  // All three must produce the same output and the same trace shape.

  const NUM = 7;
  const EXPECTED_OUTPUT = (NUM + 1) * 2; // 16

  function extractTrace(trace: StepTrace[]) {
    return trace.map((t) => ({ name: t.name, status: t.status, path: t.path }));
  }

  it("functional and fluent produce the same output and trace shape", async () => {
    const functional = workflow(
      "pipeline",
      chain(step("add1", add1), step("double", double)),
    );
    const fluent = workflow("pipeline")
      .step("add1", add1)
      .step("double", double);

    const r1 = await functional.run(NUM);
    const r2 = await fluent.run(NUM);

    expect(r1.output).toBe(EXPECTED_OUTPUT);
    expect(r2.output).toBe(EXPECTED_OUTPUT);
    expect(extractTrace(r1.trace)).toEqual(extractTrace(r2.trace));
  });

  it("functional and imperative produce the same output and trace shape", async () => {
    const functional = workflow(
      "pipeline",
      chain(step("add1", add1), step("double", double)),
    );
    const imperative = workflow("pipeline", async (n: number, ctx) => {
      const a = await ctx.step!("add1", add1, n);
      return ctx.step!("double", double, a);
    });

    const r1 = await functional.run(NUM);
    const r2 = await imperative.run(NUM);

    expect(r1.output).toBe(EXPECTED_OUTPUT);
    expect(r2.output).toBe(EXPECTED_OUTPUT);
    expect(extractTrace(r1.trace)).toEqual(extractTrace(r2.trace));
  });

  it("all three styles produce identical output AND trace", async () => {
    const functional = workflow(
      "pipeline",
      chain(step("add1", add1), step("double", double)),
    );
    const fluent = workflow("pipeline").step("add1", add1).step("double", double);
    const imperative = workflow("pipeline", async (n: number, ctx) => {
      const a = await ctx.step!("add1", add1, n);
      return ctx.step!("double", double, a);
    });

    const [r1, r2, r3] = await Promise.all([
      functional.run(NUM),
      fluent.run(NUM),
      imperative.run(NUM),
    ]);

    // All produce the same output
    expect(r1.output).toBe(EXPECTED_OUTPUT);
    expect(r2.output).toBe(r1.output);
    expect(r3.output).toBe(r1.output);

    // All produce the same trace shape (name + status + path)
    expect(extractTrace(r2.trace)).toEqual(extractTrace(r1.trace));
    expect(extractTrace(r3.trace)).toEqual(extractTrace(r1.trace));
  });
});
