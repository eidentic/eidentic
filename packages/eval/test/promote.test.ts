import { describe, it, expect } from "vitest";
import { textBlock, toolUseBlock } from "@eidentic/types";
import type { StoredEvent } from "@eidentic/types";
import { promoteTraceToEvalCase, collectPromotedCases } from "../src/promote.js";
import { evaluate } from "../src/evaluate.js";
import { trajectory } from "../src/deterministic.js";
import type { Runner, RunnerResult } from "../src/runner.js";

// ---------------------------------------------------------------------------
// Synthetic trace helpers
// ---------------------------------------------------------------------------

function buildTrace(sessionId: string): StoredEvent[] {
  const base = { sessionId, schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z" } as const;
  return [
    {
      ...base,
      id: "e0",
      seq: 0,
      kind: "user" as const,
      payload: "What is the capital of France?",
    },
    {
      ...base,
      id: "e1",
      seq: 1,
      kind: "assistant" as const,
      payload: { content: [toolUseBlock("c1", "search", { q: "capital of France" })] },
      meta: { usage: { inputTokens: 10, outputTokens: 8 } },
    },
    {
      ...base,
      id: "e2",
      seq: 2,
      kind: "tool_result" as const,
      payload: { callId: "c1", toolName: "search", output: { result: "Paris" } },
    },
    {
      ...base,
      id: "e3",
      seq: 3,
      kind: "assistant" as const,
      payload: { content: [textBlock("The capital of France is Paris.")] },
      meta: { usage: { inputTokens: 20, outputTokens: 10 } },
    },
  ];
}

/** A trace where the last assistant event has no text — only tool_use blocks. */
function buildToolOnlyTrace(sessionId: string): StoredEvent[] {
  const base = { sessionId, schemaVersion: 1, createdAt: "t" } as const;
  return [
    { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "Do something" },
    {
      ...base,
      id: "e1",
      seq: 1,
      kind: "assistant" as const,
      payload: { content: [toolUseBlock("c1", "act", { x: 1 })] },
    },
    {
      ...base,
      id: "e2",
      seq: 2,
      kind: "tool_result" as const,
      payload: { callId: "c1", toolName: "act", output: "done" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("promoteTraceToEvalCase — core", () => {
  it("extracts the user input from the first user event", () => {
    const events = buildTrace("prod-123");
    const c = promoteTraceToEvalCase(events, { sourceRunId: "prod-123" });
    expect(c.input).toBe("What is the capital of France?");
  });

  it("uses the observed final assistant text as groundTruth (regression baseline)", () => {
    const events = buildTrace("prod-123");
    const c = promoteTraceToEvalCase(events, { sourceRunId: "prod-123" });
    expect(c.groundTruth).toBe("The capital of France is Paris.");
  });

  it("sets groundTruth to null when useObservedAsBaseline is false", () => {
    const events = buildTrace("prod-123");
    const c = promoteTraceToEvalCase(events, { sourceRunId: "prod-123", useObservedAsBaseline: false });
    expect(c.groundTruth).toBeNull();
  });

  it("preserves the full captured events in capturedEvents", () => {
    const events = buildTrace("prod-456");
    const c = promoteTraceToEvalCase(events);
    expect(c.capturedEvents).toEqual(events);
  });

  it("uses a custom id when provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("s1"), { id: "my-golden-case" });
    expect(c.id).toBe("my-golden-case");
  });

  it("defaults id to promoted_<sourceRunId> when sourceRunId is given", () => {
    const c = promoteTraceToEvalCase(buildTrace("run-abc"), { sourceRunId: "run-abc" });
    expect(c.id).toBe("promoted_run-abc");
  });

  it("defaults id to promoted_unknown when no id or sourceRunId given", () => {
    const c = promoteTraceToEvalCase(buildTrace("s"));
    expect(c.id).toBe("promoted_unknown");
  });
});

// ---------------------------------------------------------------------------
// Metadata / provenance
// ---------------------------------------------------------------------------

describe("promoteTraceToEvalCase — metadata", () => {
  it("records sourceRunId in meta", () => {
    const c = promoteTraceToEvalCase(buildTrace("run-99"), { sourceRunId: "run-99" }) as typeof c & { meta?: Record<string, unknown> };
    expect((c as { meta?: Record<string, unknown> }).meta?.["sourceRunId"]).toBe("run-99");
  });

  it("records promotedAt in meta when provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1"), {
      sourceRunId: "r1",
      promotedAt: "2026-06-09T12:00:00.000Z",
    }) as { meta?: Record<string, unknown> };
    expect(c.meta?.["promotedAt"]).toBe("2026-06-09T12:00:00.000Z");
  });

  it("records tags in meta when provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1"), {
      sourceRunId: "r1",
      tags: { env: "production", model: "claude-sonnet-4" },
    }) as { meta?: Record<string, unknown> };
    expect(c.meta?.["tags"]).toEqual({ env: "production", model: "claude-sonnet-4" });
  });

  it("omits meta entirely when no provenance fields are provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1")) as { meta?: Record<string, unknown> };
    expect(c.meta).toBeUndefined();
  });

  it("omits promotedAt from meta when not provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1"), { sourceRunId: "r1" }) as { meta?: Record<string, unknown> };
    expect(c.meta?.["promotedAt"]).toBeUndefined();
    expect(c.meta?.["sourceRunId"]).toBe("r1");
  });

  it("passes through expected expectations unchanged", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1"), {
      expected: { expectedTools: ["search"], maxToolCalls: 2 },
    });
    expect(c.expected?.expectedTools).toEqual(["search"]);
    expect(c.expected?.maxToolCalls).toBe(2);
  });

  it("omits expected when not provided", () => {
    const c = promoteTraceToEvalCase(buildTrace("r1"));
    expect(c.expected).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases for observed output extraction
// ---------------------------------------------------------------------------

describe("promoteTraceToEvalCase — observed output extraction", () => {
  it("returns empty string as groundTruth when no assistant text in trace", () => {
    const c = promoteTraceToEvalCase(buildToolOnlyTrace("s1"));
    expect(c.groundTruth).toBe("");
  });

  it("uses the LAST assistant text event (not the first) when multiple exist", () => {
    const base = { sessionId: "s", schemaVersion: 1, createdAt: "t" } as const;
    const events: StoredEvent[] = [
      { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "hello" },
      {
        ...base, id: "e1", seq: 1, kind: "assistant" as const,
        payload: { content: [textBlock("First turn text")] },
      },
      { ...base, id: "e2", seq: 2, kind: "tool_result" as const, payload: { callId: "c1", toolName: "t", output: "r" } },
      {
        ...base, id: "e3", seq: 3, kind: "assistant" as const,
        payload: { content: [textBlock("Final answer")] },
      },
    ];
    const c = promoteTraceToEvalCase(events);
    expect(c.groundTruth).toBe("Final answer");
  });

  it("joins multiple text blocks in the final assistant event", () => {
    const base = { sessionId: "s", schemaVersion: 1, createdAt: "t" } as const;
    const events: StoredEvent[] = [
      { ...base, id: "e0", seq: 0, kind: "user" as const, payload: "q" },
      {
        ...base, id: "e1", seq: 1, kind: "assistant" as const,
        payload: { content: [textBlock("Part A. "), textBlock("Part B.")] },
      },
    ];
    const c = promoteTraceToEvalCase(events);
    expect(c.groundTruth).toBe("Part A. Part B.");
  });

  it("extracts input from the first user event even when non-string payload", () => {
    const base = { sessionId: "s", schemaVersion: 1, createdAt: "t" } as const;
    const events: StoredEvent[] = [
      { ...base, id: "e0", seq: 0, kind: "user" as const, payload: 42 as unknown as string },
      {
        ...base, id: "e1", seq: 1, kind: "assistant" as const,
        payload: { content: [textBlock("answer")] },
      },
    ];
    const c = promoteTraceToEvalCase(events);
    expect(c.input).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// Error handling — empty / malformed trace
// ---------------------------------------------------------------------------

describe("promoteTraceToEvalCase — error handling", () => {
  it("throws a clear error on empty events array", () => {
    expect(() => promoteTraceToEvalCase([])).toThrow(
      /promoteTraceToEvalCase.*empty array/,
    );
  });

  it("throws a clear error when events is not an array (null)", () => {
    expect(() => promoteTraceToEvalCase(null as unknown as StoredEvent[])).toThrow(
      /promoteTraceToEvalCase/,
    );
  });

  it("throws a clear error when events is not an array (string)", () => {
    expect(() => promoteTraceToEvalCase("bad" as unknown as StoredEvent[])).toThrow(
      /promoteTraceToEvalCase/,
    );
  });
});

// ---------------------------------------------------------------------------
// collectPromotedCases
// ---------------------------------------------------------------------------

describe("collectPromotedCases", () => {
  it("produces an EvalDataset with the given name and cases", () => {
    const c1 = promoteTraceToEvalCase(buildTrace("r1"), { sourceRunId: "r1" });
    const c2 = promoteTraceToEvalCase(buildTrace("r2"), { sourceRunId: "r2" });
    const ds = collectPromotedCases("prod-golden", [c1, c2]);
    expect(ds.name).toBe("prod-golden");
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0]!.id).toBe("promoted_r1");
    expect(ds.cases[1]!.id).toBe("promoted_r2");
  });

  it("produces an EvalDataset with empty cases list", () => {
    const ds = collectPromotedCases("empty-set", []);
    expect(ds.name).toBe("empty-set");
    expect(ds.cases).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: promoted case is runnable by the existing evaluate() runner
// ---------------------------------------------------------------------------

describe("promoteTraceToEvalCase — runnable by evaluate()", () => {
  it("a promoted case with expectedTools is scored correctly by toolCorrectness", async () => {
    const trace = buildTrace("prod-e2e");

    // Promote with expectations derived from observing the production trace.
    const promoted = promoteTraceToEvalCase(trace, {
      sourceRunId: "prod-e2e",
      promotedAt: "2026-06-09T00:00:00.000Z",
      tags: { env: "production" },
      expected: { expectedTools: ["search"] },
    });

    const ds = collectPromotedCases("golden", [promoted]);

    // Runner replays the captured events directly (no live model needed).
    const fakeRunner: Runner = async (): Promise<RunnerResult> => ({
      sessionId: "prod-e2e",
      events: trace,
      finalText: "The capital of France is Paris.",
      finalSubtype: "success",
    });

    const report = await evaluate(fakeRunner, ds, {
      scorers: [trajectory.toolCorrectness, trajectory.verifierStall],
    });

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.caseId).toBe("promoted_prod-e2e");
    expect(report.cases[0]!.scorerMeans["toolCorrectness"]?.pass).toBe(1);
    expect(report.cases[0]!.scorerMeans["verifierStall"]?.pass).toBe(1);
    expect(report.aggregate["toolCorrectness"]?.pass).toBe(1);
  });

  it("multiple promoted cases round-trip through evaluate() with correct aggregation", async () => {
    const trace1 = buildTrace("r1");
    const trace2 = buildTrace("r2");

    const c1 = promoteTraceToEvalCase(trace1, { sourceRunId: "r1", expected: { expectedTools: ["search"] } });
    const c2 = promoteTraceToEvalCase(trace2, { sourceRunId: "r2", expected: { expectedTools: ["search"] } });
    const ds = collectPromotedCases("multi-golden", [c1, c2]);

    const fakeRunner: Runner = async (input: string): Promise<RunnerResult> => ({
      sessionId: "r",
      events: buildTrace("r"),
      finalText: "The capital of France is Paris.",
    });

    const report = await evaluate(fakeRunner, ds, { scorers: [trajectory.toolCorrectness] });

    expect(report.cases).toHaveLength(2);
    expect(report.aggregate["toolCorrectness"]?.n).toBe(2);
    expect(report.aggregate["toolCorrectness"]?.pass).toBe(1);
  });
});
