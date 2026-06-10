import { describe, it, expect, vi } from "vitest";
import { expectTypeOf } from "vitest";
import {
  step,
  chain,
  parallel,
  branch,
  retry,
  fallback,
  withTimeout,
  map,
  tap,
  agentStep,
  workflow,
} from "@eidentic/workflow";
import type { Step, StepContext, WorkflowEvent, StepTrace } from "@eidentic/workflow";
import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(opts?: {
  signal?: AbortSignal;
  onEvent?: (e: WorkflowEvent) => void;
}): StepContext & { _traces: StepTrace[]; events: WorkflowEvent[] } {
  const traces: StepTrace[] = [];
  const events: WorkflowEvent[] = [];
  return {
    signal: opts?.signal,
    path: [],
    _traces: traces,
    events,
    emit(e: WorkflowEvent) {
      events.push(e);
      opts?.onEvent?.(e);
    },
  };
}

const identity = <T>(x: T): Step<T, T> => async (input) => input;
const numToStr: Step<number, string> = async (n) => String(n);
const strToNum: Step<string, number> = async (s) => s.length;
const strToBool: Step<string, boolean> = async (s) => s.length > 0;
const double: Step<number, number> = async (n) => n * 2;
const add1: Step<number, number> = async (n) => n + 1;

function makeAgent(responses: string[]) {
  const store = new InMemoryStore();
  const model = new MockModel(
    responses.map((text) => ({
      content: [{ type: "text" as const, text }],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
  );
  return new Agent({
    id: "test",
    instructions: "test",
    model,
    store,
  });
}

// ─── step() ─────────────────────────────────────────────────────────────────

describe("step()", () => {
  it("wraps a function and records a trace entry on success", async () => {
    const ctx = makeCtx();
    const named = step("add1", add1);
    const result = await named(5, ctx);
    expect(result).toBe(6);
    expect(ctx._traces).toHaveLength(1);
    const t = ctx._traces[0]!;
    expect(t.name).toBe("add1");
    expect(t.status).toBe("ok");
    expect(t.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.path).toEqual(["add1"]);
  });

  it("records an error trace on failure and re-throws", async () => {
    const ctx = makeCtx();
    const boom: Step<number, number> = async () => {
      throw new Error("kaboom");
    };
    const named = step("boom", boom);
    await expect(named(1, ctx)).rejects.toThrow("kaboom");
    expect(ctx._traces[0]!.status).toBe("error");
    expect(ctx._traces[0]!.error).toBe("kaboom");
  });

  it("emits step.start and step.finish events", async () => {
    const events: WorkflowEvent[] = [];
    const ctx = makeCtx({ onEvent: (e) => events.push(e) });
    await step("x", add1)(5, ctx);
    expect(events.map((e) => e.type)).toEqual(["step.start", "step.finish"]);
  });

  it("emits step.error on failure", async () => {
    const events: WorkflowEvent[] = [];
    const ctx = makeCtx({ onEvent: (e) => events.push(e) });
    const boom: Step<number, number> = async () => {
      throw new Error("oops");
    };
    await step("boom", boom)(1, ctx).catch(() => {});
    expect(events.map((e) => e.type)).toEqual(["step.start", "step.error"]);
  });

  it("nests path when inside another step", async () => {
    const ctx = makeCtx();
    const inner = step("inner", add1);
    const outer = step("outer", async (n: number, c) => inner(n, c));
    await outer(1, ctx);
    expect(ctx._traces.map((t) => t.name)).toEqual(["inner", "outer"]);
    expect(ctx._traces[0]!.path).toEqual(["outer", "inner"]);
  });
});

// ─── chain() ────────────────────────────────────────────────────────────────

describe("chain()", () => {
  it("pipes output of each step into the next", async () => {
    const ctx = makeCtx();
    const piped = chain(numToStr, strToNum);
    expect(await piped(123, ctx)).toBe(3); // "123".length
  });

  it("three-step chain executes in order", async () => {
    const order: number[] = [];
    const s1: Step<number, number> = async (n) => { order.push(1); return n + 1; };
    const s2: Step<number, number> = async (n) => { order.push(2); return n * 2; };
    const s3: Step<number, number> = async (n) => { order.push(3); return n - 1; };
    const ctx = makeCtx();
    const result = await chain(s1, s2, s3)(5, ctx);
    expect(order).toEqual([1, 2, 3]);
    expect(result).toBe(11); // (5+1)*2 - 1
  });

  it("propagates abort signal through chain", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const slow: Step<number, number> = async (n) => {
      ac.abort();
      return n;
    };
    const boom: Step<number, number> = async () => {
      throw new Error("should not reach");
    };
    const piped = chain(slow, boom);
    await expect(piped(1, ctx)).rejects.toThrow();
  });

  it("single-step chain runs that step (runtime identity)", async () => {
    const ctx = makeCtx();
    const piped = chain(numToStr);
    expect(await piped(42, ctx)).toBe("42");
  });

  it("runs a 12-step chain in order (no 8-step cap)", async () => {
    const order: number[] = [];
    const mk = (i: number): Step<number, number> => async (n) => {
      order.push(i);
      return n + i;
    };
    const ctx = makeCtx();
    // 12 steps, each adds its 1-based index: sum(1..12) = 78
    const piped = chain(
      mk(1), mk(2), mk(3), mk(4), mk(5), mk(6),
      mk(7), mk(8), mk(9), mk(10), mk(11), mk(12),
    );
    const result = await piped(0, ctx);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(result).toBe(78);
  });
});

// ─── Type-inference tests ────────────────────────────────────────────────────

describe("type inference", () => {
  it("chain<A,B,C> infers Step<A,C>", () => {
    const result = chain(numToStr, strToBool);
    expectTypeOf(result).toEqualTypeOf<Step<number, boolean>>();
  });

  it("chain<A,B,C,D> infers correctly", () => {
    const result = chain(numToStr, strToNum, double);
    expectTypeOf(result).toEqualTypeOf<Step<number, number>>();
  });

  it("parallel infers typed object result", () => {
    const prl = parallel({ len: strToNum, flag: strToBool });
    expectTypeOf(prl).toEqualTypeOf<Step<string, { len: number; flag: boolean }>>();
  });
  // NOTE: the full variadic-`chain` type proofs (12+ step inference, exact
  // first-in/last-out, mixed wrappers, adjacency compile-errors) live in the
  // dedicated type-only suite `test/chain.test-d.ts` (checked by `tsc`).
});

// ─── parallel() ─────────────────────────────────────────────────────────────

describe("parallel()", () => {
  it("runs all steps on the same input and returns typed object", async () => {
    const ctx = makeCtx();
    const prl = parallel({ len: strToNum, flag: strToBool });
    const result = await prl("hello", ctx);
    expect(result).toEqual({ len: 5, flag: true });
  });

  it("rejects when one step fails, after others settle", async () => {
    const ctx = makeCtx();
    const settled: string[] = [];
    const a: Step<string, string> = async (s) => { settled.push("a"); return s; };
    const b: Step<string, string> = async () => { settled.push("b"); throw new Error("b-fail"); };
    const prl = parallel({ a, b });
    await expect(prl("x", ctx)).rejects.toThrow("b-fail");
    expect(settled.sort()).toEqual(["a", "b"]);
  });

  it("parallel result object has correct keys", async () => {
    const ctx = makeCtx();
    const prl = parallel({ x: add1, y: double });
    const result = await prl(3, ctx);
    expect(result.x).toBe(4);
    expect(result.y).toBe(6);
  });
});

// ─── branch() ───────────────────────────────────────────────────────────────

describe("branch()", () => {
  it("executes ifTrue when predicate is true", async () => {
    const ctx = makeCtx();
    const s = branch((n: number) => n > 0, add1, double);
    expect(await s(5, ctx)).toBe(6);
  });

  it("executes ifFalse when predicate is false", async () => {
    const ctx = makeCtx();
    const s = branch((n: number) => n > 0, add1, double);
    expect(await s(0, ctx)).toBe(0);
  });

  it("supports async predicate", async () => {
    const ctx = makeCtx();
    const s = branch(async (n: number) => n > 10, add1, double);
    expect(await s(20, ctx)).toBe(21);
  });
});

// ─── retry() ────────────────────────────────────────────────────────────────

describe("retry()", () => {
  it("retries on failure then succeeds", async () => {
    const ctx = makeCtx();
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return n;
    };
    const retried = retry(flaky, { maxAttempts: 3 });
    expect(await retried(42, ctx)).toBe(42);
    expect(attempts).toBe(3);
  });

  it("throws after exhausting all attempts", async () => {
    const ctx = makeCtx();
    const always: Step<number, number> = async () => { throw new Error("always"); };
    const retried = retry(always, { maxAttempts: 3 });
    await expect(retried(1, ctx)).rejects.toThrow("always");
  });

  it("does NOT retry an AbortError", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    let attempts = 0;
    const aborting: Step<number, number> = async () => {
      attempts++;
      const err = new Error("AbortError") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    };
    const retried = retry(aborting, { maxAttempts: 5 });
    await expect(retried(1, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(1);
  });

  it("respects shouldRetry predicate", async () => {
    const ctx = makeCtx();
    let attempts = 0;
    const flaky: Step<number, number> = async () => {
      attempts++;
      throw new Error(attempts < 2 ? "retryable" : "permanent");
    };
    const retried = retry(flaky, {
      maxAttempts: 5,
      shouldRetry: (e) => e instanceof Error && e.message === "retryable",
    });
    await expect(retried(1, ctx)).rejects.toThrow("permanent");
    expect(attempts).toBe(2);
  });
});

// ─── fallback() ─────────────────────────────────────────────────────────────

describe("fallback()", () => {
  it("returns primary result when it succeeds", async () => {
    const ctx = makeCtx();
    const s = fallback(add1, double);
    expect(await s(5, ctx)).toBe(6);
  });

  it("uses fallback when primary fails", async () => {
    const ctx = makeCtx();
    const fail: Step<number, number> = async () => { throw new Error("primary fail"); };
    const s = fallback(fail, double);
    expect(await s(5, ctx)).toBe(10);
  });

  it("throws when all fail", async () => {
    const ctx = makeCtx();
    const fail1: Step<number, number> = async () => { throw new Error("fail1"); };
    const fail2: Step<number, number> = async () => { throw new Error("fail2"); };
    await expect(fallback(fail1, fail2)(1, ctx)).rejects.toThrow("fail2");
  });

  it("propagates AbortError immediately", async () => {
    const ctx = makeCtx();
    let fb1Called = false;
    const abort: Step<number, number> = async () => {
      const e = new Error("AbortError") as Error & { name: string };
      e.name = "AbortError";
      throw e;
    };
    const fb1: Step<number, number> = async (n) => { fb1Called = true; return n; };
    await expect(fallback(abort, fb1)(1, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(fb1Called).toBe(false);
  });
});

// ─── withTimeout() ──────────────────────────────────────────────────────────

describe("withTimeout()", () => {
  it("resolves fast step within timeout", async () => {
    const ctx = makeCtx();
    const fast: Step<number, number> = async (n) => n;
    expect(await withTimeout(fast, 1000)(5, ctx)).toBe(5);
  });

  it("rejects slow step after timeout", async () => {
    const ctx = makeCtx();
    const slow: Step<number, number> = () =>
      new Promise((resolve) => setTimeout(() => resolve(0), 500));
    await expect(withTimeout(slow, 10)(1, ctx)).rejects.toThrow(/timed out/);
  });

  it("aborts inner step via linked signal when timeout fires", async () => {
    let innerSignal: AbortSignal | undefined;
    const ctx = makeCtx();
    const slow: Step<number, number> = async (_, c) => {
      innerSignal = c.signal;
      return new Promise((resolve) => setTimeout(() => resolve(0), 500));
    };
    await expect(withTimeout(slow, 20)(1, ctx)).rejects.toThrow();
    // Wait a tick for the abort to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(innerSignal?.aborted).toBe(true);
  });
});

// ─── map() ──────────────────────────────────────────────────────────────────

describe("map()", () => {
  it("maps over an array and preserves order", async () => {
    const ctx = makeCtx();
    const result = await map(double)([ 1, 2, 3, 4 ], ctx);
    expect(result).toEqual([2, 4, 6, 8]);
  });

  it("respects bounded concurrency via peak counter", async () => {
    const ctx = makeCtx();
    let peak = 0;
    let active = 0;
    const tracked: Step<number, number> = async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return n;
    };
    await map(tracked, { concurrency: 2 })([1, 2, 3, 4, 5, 6], ctx);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects with index info on element failure", async () => {
    const ctx = makeCtx();
    const failOn2: Step<number, number> = async (n) => {
      if (n === 2) throw new Error("two-fail");
      return n;
    };
    await expect(map(failOn2)([1, 2, 3], ctx)).rejects.toThrow(/map failed at index/);
  });
});

// ─── tap() ──────────────────────────────────────────────────────────────────

describe("tap()", () => {
  it("returns input unchanged", async () => {
    const ctx = makeCtx();
    const sideEffects: number[] = [];
    const t = tap<number>((n) => { sideEffects.push(n); });
    expect(await t(42, ctx)).toBe(42);
    expect(sideEffects).toEqual([42]);
  });

  it("awaits async side effects", async () => {
    const ctx = makeCtx();
    const log: number[] = [];
    const t = tap<number>(async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      log.push(n);
    });
    await t(99, ctx);
    expect(log).toEqual([99]);
  });
});

// ─── agentStep() ─────────────────────────────────────────────────────────────

describe("agentStep()", () => {
  it("drains agent output and returns the text by default", async () => {
    const ctx = makeCtx();
    const agent = makeAgent(["hello from agent"]);
    const s = agentStep(agent);
    const result = await s("ping", ctx);
    expect(result).toBe("hello from agent");
  });

  it("non-success terminal throws an error", async () => {
    const store = new InMemoryStore();
    let resolved = false;
    // MockModel with maxTurns=0 would terminate with max_turns, but we can simulate by
    // using a model that returns a response triggering a non-success path via max_turns config.
    const model = new MockModel([
      {
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const agent = new Agent({
      id: "test",
      instructions: "test",
      model,
      store,
      maxTurns: 0, // immediately terminates with max_turns
    });
    const s = agentStep(agent);
    const ctx = makeCtx();
    await expect(s("ping", ctx)).rejects.toThrow(/subtype="max_turns"/);
    resolved = true;
    expect(resolved).toBe(true);
  });

  it("uses custom toInput and fromOutput", async () => {
    const ctx = makeCtx();
    const agent = makeAgent(["42"]);
    const s = agentStep<number, number>(agent, {
      toInput: (n) => `give me ${n}`,
      fromOutput: (t) => parseInt(String(t.output), 10),
    });
    const result = await s(5, ctx);
    expect(result).toBe(42);
  });

  it("forwards signal to agent.query", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    ac.abort(); // pre-aborted
    const agent = makeAgent(["should not be called"]);
    const s = agentStep(agent);
    await expect(s("ping", ctx)).rejects.toThrow();
  });

  it("forwards userId into agent.query when provided", async () => {
    // Use a stub agent that captures query options
    const capturedOpts: Array<Record<string, unknown>> = [];
    const stubAgent = {
      async *query(input: unknown, opts: Record<string, unknown>) {
        capturedOpts.push({ ...opts });
        // Yield a minimal success result event so agentStep completes
        yield { type: "result", subtype: "success", output: "pong", object: undefined };
      },
    } as unknown as Parameters<typeof agentStep>[0];

    const ctx = makeCtx();
    const s = agentStep(stubAgent, { userId: "u-42" });
    await s("hello", ctx);

    expect(capturedOpts.length).toBeGreaterThan(0);
    expect(capturedOpts[0]!["userId"]).toBe("u-42");
  });

  it("forwards orgId into agent.query when provided", async () => {
    const capturedOpts: Array<Record<string, unknown>> = [];
    const stubAgent = {
      async *query(input: unknown, opts: Record<string, unknown>) {
        capturedOpts.push({ ...opts });
        yield { type: "result", subtype: "success", output: "resp", object: undefined };
      },
    } as unknown as Parameters<typeof agentStep>[0];

    const ctx = makeCtx();
    const s = agentStep(stubAgent, { orgId: "org-99" });
    await s("hello", ctx);

    expect(capturedOpts.length).toBeGreaterThan(0);
    expect(capturedOpts[0]!["orgId"]).toBe("org-99");
  });

  it("does not pass userId/orgId when not provided (back-compat)", async () => {
    const capturedOpts: Array<Record<string, unknown>> = [];
    const stubAgent = {
      async *query(input: unknown, opts: Record<string, unknown>) {
        capturedOpts.push({ ...opts });
        yield { type: "result", subtype: "success", output: "resp", object: undefined };
      },
    } as unknown as Parameters<typeof agentStep>[0];

    const ctx = makeCtx();
    const s = agentStep(stubAgent);
    await s("hello", ctx);

    expect(capturedOpts.length).toBeGreaterThan(0);
    const firstOpts = capturedOpts[0]!;
    expect("userId" in firstOpts).toBe(false);
    expect("orgId" in firstOpts).toBe(false);
  });
});

// ─── workflow() ──────────────────────────────────────────────────────────────

describe("workflow()", () => {
  it("run() returns output and trace", async () => {
    const wf = workflow("double-and-add", chain(step("double", double), step("add1", add1)));
    const { output, trace } = await wf.run(5);
    expect(output).toBe(11); // 5*2 + 1
    expect(trace.map((t) => t.name)).toEqual(["double", "add1"]);
    expect(trace.every((t) => t.status === "ok")).toBe(true);
  });

  it("trace records correct step names and paths", async () => {
    const wf = workflow("test", step("my-step", add1));
    const { trace } = await wf.run(1);
    expect(trace[0]!.name).toBe("my-step");
    expect(trace[0]!.path).toEqual(["my-step"]);
  });

  it("onEvent receives start/finish events in order", async () => {
    const events: WorkflowEvent[] = [];
    const wf = workflow("w", step("s", add1));
    await wf.run(1, { onEvent: (e) => events.push(e) });
    expect(events[0]!.type).toBe("step.start");
    expect(events[1]!.type).toBe("step.finish");
  });

  it("onEvent receives step.error on failure", async () => {
    const events: WorkflowEvent[] = [];
    const boom: Step<number, number> = async () => { throw new Error("boom"); };
    const wf = workflow("w", step("fail", boom));
    await expect(wf.run(1, { onEvent: (e) => events.push(e) })).rejects.toThrow();
    expect(events.some((e) => e.type === "step.error")).toBe(true);
  });

  it("run() forwards signal to steps", async () => {
    const ac = new AbortController();
    ac.abort();
    const wf = workflow("w", add1);
    // add1 doesn't check the signal, but a signal-aware step would see it
    // just verify it doesn't throw on its own
    const result = await wf.run(5, { signal: ac.signal });
    expect(result.output).toBe(6);
  });

  it("asStep() nests workflow path into parent context", async () => {
    const inner = workflow("inner", step("op", add1));
    const outer = workflow("outer", inner.asStep());
    const { trace } = await outer.run(1);
    // inner.asStep() nests path, so the trace entry for "op" should have path ["inner", "op"]
    const opTrace = trace.find((t) => t.name === "op");
    expect(opTrace?.path).toEqual(["inner", "op"]);
  });

  it("nested workflow via asStep() composes trace", async () => {
    const inner = workflow("inner", chain(step("a", add1), step("b", double)));
    const outer = workflow("outer", inner.asStep());
    const { output, trace } = await outer.run(3);
    expect(output).toBe(8); // (3+1)*2
    expect(trace.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("custom emit via tap appears in onEvent", async () => {
    const events: WorkflowEvent[] = [];
    const wf = workflow(
      "w",
      tap<number>((n, ctx) => ctx.emit({ type: "custom", name: "my-event", data: n, at: Date.now() })),
    );
    await wf.run(7, { onEvent: (e) => events.push(e) });
    const custom = events.find((e) => e.type === "custom");
    expect(custom).toBeDefined();
    expect((custom as { type: "custom"; name: string; data: unknown }).data).toBe(7);
  });
});

// ─── Integration: chain + step + workflow ────────────────────────────────────

describe("integration", () => {
  it("chain of named steps produces trace with all names", async () => {
    const wf = workflow(
      "pipeline",
      chain(
        step("to-str", numToStr),
        step("to-bool", strToBool),
      ),
    );
    const { output, trace } = await wf.run(42);
    expect(output).toBe(true);
    expect(trace.map((t) => t.name)).toEqual(["to-str", "to-bool"]);
  });

  it("retry inside workflow recovers from transient failure", async () => {
    let attempts = 0;
    const flaky: Step<number, number> = async (n) => {
      if (++attempts < 3) throw new Error("transient");
      return n;
    };
    const wf = workflow("w", retry(step("flaky", flaky), { maxAttempts: 3 }));
    const { output } = await wf.run(99);
    expect(output).toBe(99);
    expect(attempts).toBe(3);
  });

  it("parallel + chain infers types end-to-end", () => {
    const prl = parallel({ len: strToNum, flag: strToBool });
    const result = chain(prl, tap((_r) => {}));
    expectTypeOf(result).toEqualTypeOf<Step<string, { len: number; flag: boolean }>>();
  });
});
