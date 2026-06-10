import { describe, it, expect } from "vitest";
import { trajectory } from "../src/deterministic.js";
import { trajectoryFromEvents } from "../src/trajectory.js";
import type { ScoreContext } from "../src/scorer.js";
import type { StoredEvent, ToolSchema } from "@eidentic/types";

// --- Fixture helpers ---

const ev = (seq: number, kind: StoredEvent["kind"], payload: unknown): StoredEvent =>
  ({ id: `e${seq}`, sessionId: "s", seq, kind, schemaVersion: 1, payload, createdAt: "t" });

const asst = (seq: number, ...blocks: unknown[]): StoredEvent =>
  ev(seq, "assistant", { content: blocks });

const toolUse = (callId: string, name: string, input: unknown) =>
  ({ type: "tool_use", callId, name, input });

const toolResult = (seq: number, callId: string, toolName: string, output: unknown): StoredEvent =>
  ev(seq, "tool_result", { callId, toolName, output });

function ctx(events: StoredEvent[], opts: Partial<Omit<ScoreContext, "input" | "trajectory" | "sampleIndex">> = {}): ScoreContext {
  return {
    input: "test input",
    trajectory: trajectoryFromEvents(events),
    sampleIndex: 0,
    ...opts,
  };
}

// --- toolCorrectness ---

describe("trajectory.toolCorrectness", () => {
  it("passes when no expectedTools declared", () => {
    const r = trajectory.toolCorrectness.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it("passes when all expected tools were called", () => {
    const events = [
      ev(0, "user", "go"),
      asst(1, toolUse("c1", "search", {}), toolUse("c2", "write", {})),
    ];
    const r = trajectory.toolCorrectness.score(ctx(events, { expected: { expectedTools: ["search", "write"] } }));
    expect(r.passed).toBe(true);
  });

  it("fails when an expected tool was not called", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", {}))];
    const r = trajectory.toolCorrectness.score(ctx(events, { expected: { expectedTools: ["search", "write"] } }));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toContain("write");
  });

  it("is idempotent (same context, same result)", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", {}))];
    const c = ctx(events, { expected: { expectedTools: ["search"] } });
    expect(JSON.stringify(trajectory.toolCorrectness.score(c))).toBe(JSON.stringify(trajectory.toolCorrectness.score(c)));
  });
});

// --- requiredParams ---

describe("trajectory.requiredParams", () => {
  it("passes when no rules declared", () => {
    const r = trajectory.requiredParams.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
  });

  it("passes when all required params are present", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a", content: "hi" }))];
    const r = trajectory.requiredParams.score(ctx(events, { expected: { requiredParams: { write_file: ["path", "content"] } } }));
    expect(r.passed).toBe(true);
  });

  it("fails when a required param is absent", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a" }))];
    const r = trajectory.requiredParams.score(ctx(events, { expected: { requiredParams: { write_file: ["path", "content"] } } }));
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("violations");
  });

  it("fails when the required tool was never called", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", {}))];
    const r = trajectory.requiredParams.score(ctx(events, { expected: { requiredParams: { write_file: ["path"] } } }));
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("violations");
  });
});

// --- schemaValidity ---

describe("trajectory.schemaValidity", () => {
  const schema: ToolSchema = {
    name: "write_file",
    description: "write a file",
    inputSchema: {
      type: "object",
      properties: { path: {}, content: {} },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };

  it("passes when no schemas supplied", () => {
    const r = trajectory.schemaValidity.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
  });

  it("passes when all tool inputs match schema", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a", content: "hi" }))];
    const r = trajectory.schemaValidity.score(ctx(events, { toolSchemas: [schema] }));
    expect(r.passed).toBe(true);
  });

  it("fails when a required prop is missing", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a" }))];
    const r = trajectory.schemaValidity.score(ctx(events, { toolSchemas: [schema] }));
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("violations");
  });

  it("fails when an unexpected property is present (additionalProperties:false)", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a", content: "x", extra: true }))];
    const r = trajectory.schemaValidity.score(ctx(events, { toolSchemas: [schema] }));
    expect(r.passed).toBe(false);
  });

  it("ignores tool calls for unknown tools (not in schemas)", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", { q: "x" }))];
    // schema only covers write_file; search is unknown
    const r = trajectory.schemaValidity.score(ctx(events, { toolSchemas: [schema] }));
    expect(r.passed).toBe(true);
  });
});

// --- idempotencyKeyPresence ---

describe("trajectory.idempotencyKeyPresence", () => {
  const mutatingSchema: ToolSchema & { sideEffect: string } = {
    name: "write_file",
    description: "write a file",
    inputSchema: {},
    sideEffect: "destructive",
  } as unknown as ToolSchema & { sideEffect: string };

  const readOnlySchema: ToolSchema & { sideEffect: string } = {
    name: "read_file",
    description: "read a file",
    inputSchema: {},
    sideEffect: "read-only",
  } as unknown as ToolSchema & { sideEffect: string };

  it("passes (nothing to key) when no mutating tool schemas", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", {}))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events));
    expect(r.passed).toBe(true);
  });

  it("fails when a mutating tool call has no idempotencyKey field", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a" }))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events, { toolSchemas: [mutatingSchema] as unknown as ToolSchema[] }));
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("without an idempotency key");
  });

  it("passes when a mutating call has an idempotencyKey field in input", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a", idempotencyKey: "k1" }))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events, { toolSchemas: [mutatingSchema] as unknown as ToolSchema[] }));
    expect(r.passed).toBe(true);
  });

  it("passes when the schema declares idempotencyKey:true (schema-level marker)", () => {
    const markerSchema = { ...mutatingSchema, idempotencyKey: true } as unknown as ToolSchema;
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a" }))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events, { toolSchemas: [markerSchema] }));
    expect(r.passed).toBe(true);
  });

  it("read-only tools are exempt from the check", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "read_file", { path: "/a" }))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events, { toolSchemas: [readOnlySchema] as unknown as ToolSchema[] }));
    expect(r.passed).toBe(true);
    expect(r.rationale).toContain("nothing to key");
  });

  it("skips with a labeled non-actionable result when schemas lack sideEffect markers but tool calls exist", () => {
    // Public ToolSchema has no sideEffect field — simulate registry.schemas() output.
    const publicSchema: ToolSchema = { name: "write_file", description: "write a file", inputSchema: {} };
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "write_file", { path: "/a" }))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events, { toolSchemas: [publicSchema] }));
    // Must NOT fail (don't penalise a run for a metric we cannot compute), but must be labeled.
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toContain("skipped");
    expect(r.rationale).toContain("sideEffect");
    expect((r.details as Record<string, unknown>)?.skipped).toBeDefined();
  });

  it("skips when no schemas are supplied at all but tool calls exist", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "anything", {}))];
    const r = trajectory.idempotencyKeyPresence.score(ctx(events));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.rationale).toContain("skipped");
  });
});

// --- toolSequence ---

describe("trajectory.toolSequence", () => {
  it("passes when no sequence declared", () => {
    const r = trajectory.toolSequence.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
  });

  it("passes when the exact sequence matches", () => {
    const events = [
      ev(0, "user", "go"),
      asst(1, toolUse("c1", "read", {})),
      asst(2, toolUse("c2", "write", {})),
    ];
    const r = trajectory.toolSequence.score(ctx(events, { expected: { expectedSequence: ["read", "write"] } }));
    expect(r.passed).toBe(true);
  });

  it("fails when the order is wrong", () => {
    const events = [
      ev(0, "user", "go"),
      asst(1, toolUse("c1", "write", {})),
      asst(2, toolUse("c2", "read", {})),
    ];
    const r = trajectory.toolSequence.score(ctx(events, { expected: { expectedSequence: ["read", "write"] } }));
    expect(r.passed).toBe(false);
  });

  it("fails when extra tools are called", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "read", {}), toolUse("c2", "extra", {}), toolUse("c3", "write", {}))];
    const r = trajectory.toolSequence.score(ctx(events, { expected: { expectedSequence: ["read", "write"] } }));
    expect(r.passed).toBe(false);
  });
});

// --- stepEfficiency ---

describe("trajectory.stepEfficiency", () => {
  it("passes when no budget declared", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "x", {}), toolUse("c2", "x", {}), toolUse("c3", "x", {}))];
    const r = trajectory.stepEfficiency.score(ctx(events));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it("passes when within budget", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "x", {}))];
    const r = trajectory.stepEfficiency.score(ctx(events, { expected: { maxToolCalls: 3 } }));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails with degraded score when over budget", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "x", {}), toolUse("c2", "x", {}), toolUse("c3", "x", {}), toolUse("c4", "x", {}))];
    const r = trajectory.stepEfficiency.score(ctx(events, { expected: { maxToolCalls: 2 } }));
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(1);
    expect(r.score).toBeGreaterThan(0);
  });

  it("score is clamped to [0,1]", () => {
    const events = [ev(0, "user", "go"), asst(1, ...Array.from({ length: 100 }, (_, i) => toolUse(`c${i}`, "x", {})))];
    const r = trajectory.stepEfficiency.score(ctx(events, { expected: { maxToolCalls: 1 } }));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

// --- verifierStall ---

describe("trajectory.verifierStall", () => {
  it("passes when no tool calls", () => {
    const r = trajectory.verifierStall.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
  });

  it("passes when max same-name run is exactly 10 (not > 10)", () => {
    const uses = Array.from({ length: 10 }, (_, i) => toolUse(`c${i}`, "check", {}));
    const events = [ev(0, "user", "go"), asst(1, ...uses)];
    const r = trajectory.verifierStall.score(ctx(events));
    expect(r.passed).toBe(true);
  });

  it("fails when max same-name run is 11 (> 10)", () => {
    const uses = Array.from({ length: 11 }, (_, i) => toolUse(`c${i}`, "check", {}));
    const events = [ev(0, "user", "go"), asst(1, ...uses)];
    const r = trajectory.verifierStall.score(ctx(events));
    expect(r.passed).toBe(false);
    expect(r.rationale).toContain("stall");
  });

  it("fails when >12 consecutive same-name calls", () => {
    const uses = Array.from({ length: 12 }, (_, i) => toolUse(`c${i}`, "check", {}));
    const events = [ev(0, "user", "go"), asst(1, ...uses)];
    const r = trajectory.verifierStall.score(ctx(events));
    expect(r.passed).toBe(false);
  });

  it("respects a custom maxSameNameRun threshold", () => {
    const uses = Array.from({ length: 3 }, (_, i) => toolUse(`c${i}`, "check", {}));
    const events = [ev(0, "user", "go"), asst(1, ...uses)];
    const r = trajectory.verifierStall.score(ctx(events, { expected: { maxSameNameRun: 2 } }));
    expect(r.passed).toBe(false); // 3 > 2
  });
});

// --- noRepeatedSteps ---

describe("trajectory.noRepeatedSteps", () => {
  it("passes when no tool calls", () => {
    const r = trajectory.noRepeatedSteps.score(ctx([ev(0, "user", "go")]));
    expect(r.passed).toBe(true);
  });

  it("passes when all calls are distinct (different inputs)", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", { q: "a" }), toolUse("c2", "search", { q: "b" }))];
    const r = trajectory.noRepeatedSteps.score(ctx(events));
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails when the same (name+input) appears twice", () => {
    const events = [ev(0, "user", "go"), asst(1, toolUse("c1", "search", { q: "x" }), toolUse("c2", "search", { q: "x" }))];
    const r = trajectory.noRepeatedSteps.score(ctx(events));
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(1);
  });

  it("score degrades proportionally with repeats", () => {
    // 4 calls: 2 unique signatures => score = 2/4 = 0.5
    const events = [ev(0, "user", "go"), asst(1,
      toolUse("c1", "search", { q: "x" }),
      toolUse("c2", "search", { q: "x" }),
      toolUse("c3", "search", { q: "y" }),
      toolUse("c4", "search", { q: "y" }),
    )];
    const r = trajectory.noRepeatedSteps.score(ctx(events));
    expect(r.score).toBeCloseTo(0.5);
  });

  it("same name with different inputs is NOT a repeat", () => {
    const events = [ev(0, "user", "go"), asst(1,
      toolUse("c1", "search", { q: "paris" }),
      toolUse("c2", "search", { q: "london" }),
    )];
    const r = trajectory.noRepeatedSteps.score(ctx(events));
    expect(r.passed).toBe(true);
  });
});

// --- Cross-cutter: error tool results don't affect deterministic scorers ---

describe("tool_result error events", () => {
  it("toolResult steps with isError do not affect toolCorrectness or requiredParams", () => {
    const events = [
      ev(0, "user", "go"),
      asst(1, toolUse("c1", "search", { q: "x" })),
      toolResult(2, "c1", "search", { error: "timeout" }),
    ];
    const traj = trajectoryFromEvents(events);
    const c: ScoreContext = { input: "go", trajectory: traj, sampleIndex: 0, expected: { expectedTools: ["search"] } };
    // The tool WAS called — even if it errored, toolCorrectness should pass
    expect(trajectory.toolCorrectness.score(c).passed).toBe(true);
  });
});
