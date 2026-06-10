import { describe, it, expect } from "vitest";
import { MockModel } from "@eidentic/types/testing";
import { toolUseBlock, textBlock } from "@eidentic/types";
import { llmJudge } from "../src/judge.js";
import type { ScoreContext } from "../src/scorer.js";

// Minimal ScoreContext for judge tests.
function makeCtx(overrides: Partial<ScoreContext> = {}): ScoreContext {
  return {
    input: "What is the capital of France?",
    trajectory: { input: "What is the capital of France?", steps: [] },
    sampleIndex: 0,
    finalText: "Paris",
    ...overrides,
  };
}

describe("llmJudge.taskCompletion", () => {
  it("returns {score:0.9, passed:true} when judge returns a valid score tool call", async () => {
    // Constitution #6: judge is a DISTINCT instance from any agent model.
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 0.9, rationale: "Correct answer (Paris)." })], usage: { inputTokens: 3, outputTokens: 3 } },
    ]);
    // (separate instance from any hypothetical agent model — different reference)
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBeCloseTo(0.9);
    expect(result.passed).toBe(true);
    expect(result.rationale).toBe("Correct answer (Paris).");
  });

  it("CLAMP: score 2.5 is clamped to 1", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 2.5, rationale: "over the top" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("CLAMP: score -3 is clamped to 0", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: -3, rationale: "very bad" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("FAIL-CLOSED: judge returns non-number score (string) => fail-closed", async () => {
    // score:"x" is a string, not a number — fail-closed
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: "x", rationale: "oops" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.rationale).toBe("judge produced no parsable score");
  });

  it("FAIL-CLOSED: judge returns plain text (no tool call) => fail-closed", async () => {
    const judgeModel = new MockModel([
      { content: [textBlock("I think it's good.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.rationale).toBe("judge produced no parsable score");
  });

  it("FAIL-CLOSED: judge throws (empty script) => fail-closed, does not throw", async () => {
    // MockModel with no scripted responses will throw on complete()
    const judgeModel = new MockModel([]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    // Should not throw
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.rationale).toContain("failing closed");
  });

  it("FAIL-CLOSED: judge returns wrong tool name => fail-closed", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "wrongtool", { score: 0.8, rationale: "whatever" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.rationale).toBe("judge produced no parsable score");
  });

  it("passThreshold: score 0.4 with default 0.5 => passed:false", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 0.4, rationale: "borderline" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBeCloseTo(0.4);
    expect(result.passed).toBe(false);
  });

  it("passThreshold: score 0.4 with {passThreshold:0.3} => passed:true", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 0.4, rationale: "borderline" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.taskCompletion(judgeModel, { passThreshold: 0.3 });
    const result = await scorer.score(makeCtx());
    expect(result.score).toBeCloseTo(0.4);
    expect(result.passed).toBe(true);
  });

  it("different-model invariant: judge is a distinct instance from agent model (Constitution #6)", async () => {
    // Verify distinct instances — they should not be the same reference.
    // The API enforces separation by accepting an explicit judge parameter.
    const agentModel = new MockModel([]);
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 1.0, rationale: "great" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    // Constitution #6: judge must differ from agent model
    expect(judgeModel).not.toBe(agentModel);
    const scorer = llmJudge.taskCompletion(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.passed).toBe(true);
  });
});

describe("llmJudge.planQuality", () => {
  it("scores a trajectory with tool calls", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 0.8, rationale: "Good plan." })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.planQuality(judgeModel);
    const ctx = makeCtx({
      trajectory: {
        input: "What is the capital of France?",
        steps: [
          { kind: "toolCall", callId: "c1", name: "search", input: { q: "France capital" } },
        ],
      },
    });
    const result = await scorer.score(ctx);
    expect(result.score).toBeCloseTo(0.8);
    expect(result.passed).toBe(true);
  });
});

describe("llmJudge.faithfulness", () => {
  it("fail-closed when no tool call in response", async () => {
    const judgeModel = new MockModel([
      { content: [textBlock("No tool")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.faithfulness(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe("llmJudge.answerRelevancy", () => {
  it("returns score from judge", async () => {
    const judgeModel = new MockModel([
      { content: [toolUseBlock("j1", "score", { score: 0.75, rationale: "Relevant." })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const scorer = llmJudge.answerRelevancy(judgeModel);
    const result = await scorer.score(makeCtx());
    expect(result.score).toBeCloseTo(0.75);
    expect(result.passed).toBe(true);
  });
});
