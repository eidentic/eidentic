import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { createTool, Agent } from "@eidentic/core";
import { evaluate } from "../src/evaluate.js";
import { createRunner } from "../src/runner.js";
import { trajectory } from "../src/deterministic.js";
import type { Runner, RunnerResult } from "../src/runner.js";
import type { EvalDataset } from "../src/dataset.js";
import type { StoredEvent } from "@eidentic/types";

// Helper: build a minimal StoredEvent log representing one search tool call + result.
function buildSearchEvents(sessionId: string): StoredEvent[] {
  const base = { sessionId, schemaVersion: 1, createdAt: "t" } as const;
  return [
    { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "find capital of France" },
    {
      ...base, id: "e1", seq: 1, kind: "assistant" as const,
      payload: { content: [toolUseBlock("c1", "search", { q: "capital of France" })] },
      meta: { usage: { inputTokens: 5, outputTokens: 5 } },
    },
    {
      ...base, id: "e2", seq: 2, kind: "tool_result" as const,
      payload: { callId: "c1", toolName: "search", output: { result: "Paris" } },
    },
    {
      ...base, id: "e3", seq: 3, kind: "assistant" as const,
      payload: { content: [textBlock("The capital of France is Paris.")] },
      meta: { usage: { inputTokens: 5, outputTokens: 5 } },
    },
  ];
}

describe("evaluate() — fake runner", () => {
  it("runs each case with the configured samples count and aggregates scorerMeans", async () => {
    let callCount = 0;
    const fakeRunner: Runner = async (input: string): Promise<RunnerResult> => {
      callCount++;
      const sid = `s${callCount}`;
      return { sessionId: sid, events: buildSearchEvents(sid), finalText: "Paris", finalSubtype: "success" };
    };

    const dataset: EvalDataset = {
      name: "test",
      cases: [{ id: "c1", input: "find capital of France", groundTruth: "Paris", expected: { expectedTools: ["search"] } }],
    };

    const report = await evaluate(fakeRunner, dataset, {
      scorers: [trajectory.toolCorrectness, trajectory.verifierStall],
      samples: 3,
    });

    expect(callCount).toBe(3);
    expect(report.cases).toHaveLength(1);
    const c = report.cases[0]!;
    expect(c.caseId).toBe("c1");
    expect(c.samples).toHaveLength(3);
    expect(c.scorerMeans["toolCorrectness"]?.n).toBe(3);
    expect(c.scorerMeans["toolCorrectness"]?.pass).toBe(1); // 3 passes / 3 samples = 1.0
    expect(report.aggregate["toolCorrectness"]?.pass).toBe(1);
    expect(report.aggregate["toolCorrectness"]?.n).toBe(3);
  });

  it("aggregates across multiple cases", async () => {
    const fakeRunner: Runner = async (): Promise<RunnerResult> => ({
      sessionId: "s",
      events: buildSearchEvents("s"),
      finalText: "Paris",
    });

    const dataset: EvalDataset = {
      name: "multi",
      cases: [
        { id: "c1", input: "q1", groundTruth: "Paris", expected: { expectedTools: ["search"] } },
        { id: "c2", input: "q2", groundTruth: "Paris", expected: { expectedTools: ["search"] } },
      ],
    };

    const report = await evaluate(fakeRunner, dataset, { scorers: [trajectory.toolCorrectness], samples: 1 });
    expect(report.aggregate["toolCorrectness"]?.n).toBe(2);
    expect(report.aggregate["toolCorrectness"]?.pass).toBe(1);
  });

  it("samples aggregation reflects mixed pass/fail across samples", async () => {
    let callCount = 0;
    // First sample returns a stall trajectory (>10 same calls), rest return a clean one.
    const fakeRunner: Runner = async (): Promise<RunnerResult> => {
      const i = callCount++;
      const sid = `s${i}`;
      const base = { sessionId: sid, schemaVersion: 1, createdAt: "t" } as const;
      if (i === 0) {
        // stall: 12 consecutive 'check' calls
        const uses = Array.from({ length: 12 }, (_, j) => toolUseBlock(`c${j}`, "check", {}));
        return {
          sessionId: sid,
          events: [
            { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "go" },
            { ...base, id: "e1", seq: 1, kind: "assistant" as const, payload: { content: uses } },
          ],
        };
      } else {
        return { sessionId: sid, events: buildSearchEvents(sid) };
      }
    };

    const dataset: EvalDataset = {
      name: "mixed",
      cases: [{ id: "c1", input: "go", groundTruth: "x" }],
    };

    const report = await evaluate(fakeRunner, dataset, { scorers: [trajectory.verifierStall], samples: 3 });
    const means = report.cases[0]!.scorerMeans["verifierStall"]!;
    // 1 fail (stall) + 2 pass = pass rate 2/3
    expect(means.n).toBe(3);
    expect(means.pass).toBeCloseTo(2 / 3);
  });
});

describe("evaluate() — failure isolation", () => {
  it("records errored case when runner throws for one case, other cases still scored, run completes", async () => {
    const goodEvents = buildSearchEvents("s-good");
    let callCount = 0;
    const fakeRunner: Runner = async (input: string): Promise<RunnerResult> => {
      callCount++;
      if (input === "bad-input") throw new Error("simulated runner failure");
      return { sessionId: "s-good", events: goodEvents, finalText: "Paris" };
    };

    const dataset: EvalDataset = {
      name: "isolation-test",
      cases: [
        { id: "good", input: "find capital of France", groundTruth: "Paris", expected: { expectedTools: ["search"] } },
        { id: "bad", input: "bad-input", groundTruth: "ignored" },
      ],
    };

    const report = await evaluate(fakeRunner, dataset, {
      scorers: [trajectory.toolCorrectness],
      samples: 1,
    });

    // Both cases must appear in the report
    expect(report.cases).toHaveLength(2);

    // Good case: scored normally
    const goodCase = report.cases.find((c) => c.caseId === "good")!;
    expect(goodCase.samples[0]!.runnerError).toBeUndefined();
    expect(goodCase.samples[0]!.scores["toolCorrectness"]?.passed).toBe(true);

    // Bad case: runner error recorded, sample has runnerError
    const badCase = report.cases.find((c) => c.caseId === "bad")!;
    expect(badCase.samples[0]!.runnerError).toContain("simulated runner failure");
    expect(badCase.samples[0]!.scores["toolCorrectness"]?.passed).toBe(false);
    expect(badCase.samples[0]!.scores["toolCorrectness"]?.rationale).toContain("runner threw");

    // Aggregate must be computable (no NaN), includes both cases
    const agg = report.aggregate["toolCorrectness"]!;
    expect(agg.n).toBe(2);
    expect(Number.isFinite(agg.mean)).toBe(true);
    expect(Number.isFinite(agg.pass)).toBe(true);
  });

  it("fail-closes a throwing scorer for that scorer only, other scorers and cases unaffected", async () => {
    const goodEvents = buildSearchEvents("s1");
    const fakeRunner: Runner = async (): Promise<RunnerResult> => ({
      sessionId: "s1",
      events: goodEvents,
      finalText: "Paris",
    });

    const throwingScorer = {
      name: "alwaysThrows",
      score(): never { throw new Error("scorer boom"); },
    };

    const dataset: EvalDataset = {
      name: "scorer-isolation",
      cases: [{ id: "c1", input: "q", groundTruth: "Paris", expected: { expectedTools: ["search"] } }],
    };

    const report = await evaluate(fakeRunner, dataset, {
      scorers: [throwingScorer, trajectory.toolCorrectness],
      samples: 1,
    });

    const sample = report.cases[0]!.samples[0]!;
    // Throwing scorer becomes fail-closed
    expect(sample.scores["alwaysThrows"]?.passed).toBe(false);
    expect(sample.scores["alwaysThrows"]?.rationale).toContain("scorer threw");
    expect(sample.scores["alwaysThrows"]?.rationale).toContain("scorer boom");
    // Other scorer still runs normally
    expect(sample.scores["toolCorrectness"]?.passed).toBe(true);
    expect(sample.runnerError).toBeUndefined();
  });
});

describe("createRunner adapter", () => {
  it("wraps a real Agent and produces correct RunnerResult (toolCorrectness passes)", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const agentModel = new MockModel([
      { content: [toolUseBlock("c1", "search", { q: "capital of France" })], usage: { inputTokens: 5, outputTokens: 5 } },
      { content: [textBlock("The capital of France is Paris.")], usage: { inputTokens: 5, outputTokens: 5 } },
    ]);

    const search = createTool({
      id: "search",
      description: "Search the web.",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ result: "Paris" }),
    });

    const agent = new Agent({
      id: "eval-test",
      instructions: "Answer using tools.",
      model: agentModel,
      tools: [search],
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    let sid = 0;
    const runner = createRunner(agent, store, { newSessionId: () => `eval_sess_${sid++}` });

    const dataset: EvalDataset = {
      name: "agent-test",
      cases: [{ id: "c1", input: "find capital of France", groundTruth: "Paris", expected: { expectedTools: ["search"] } }],
    };

    const report = await evaluate(runner, dataset, { scorers: [trajectory.toolCorrectness] });

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.scorerMeans["toolCorrectness"]?.pass).toBe(1);
    expect(report.aggregate["toolCorrectness"]?.pass).toBe(1);
    // Verify finalText from the result event was captured
    expect(report.cases[0]!.samples[0]!.scores["toolCorrectness"]?.passed).toBe(true);
  });

  it("captures finalText and finalSubtype from the stream result event", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const agentModel = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "eval-text",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    let sid = 0;
    const runner = createRunner(agent, store, { newSessionId: () => `es_${sid++}` });
    const result = await runner("hello");

    expect(result.finalText).toBe("done");
    expect(result.finalSubtype).toBe("success");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe("es_0");
  });
});
