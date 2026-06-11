/**
 * Unit + integration tests for the LongMemEval loader, harness, and markdown renderer.
 *
 * Tests are fixture-based (no network, no real LLM) except the gated integration test
 * at the bottom which requires EIDENTIC_TEST_LME=1 and data/longmemeval_s.json.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { ModelRequest, ModelResponse } from "@eidentic/types";
import { InMemoryStore, FakeEmbedder, InMemoryVectorStore } from "@eidentic/types/testing";
import { Memory } from "@eidentic/memory";
import { loadLongMemEval, parseLmeDateTimeString } from "../src/lme-loader.js";
import { runLongMemEvalBench } from "../src/lme-run.js";
import { renderLongMemEvalReportMarkdown } from "../src/lme-render.js";
import type { LmeReport } from "../src/lme-run.js";

// Path to the fixture file (committed — synthetic content we own)
const FIXTURE_PATH = resolve(__dirname, "fixtures/lme-fixture.json");

// ── Helper: Mock ModelPort ─────────────────────────────────────────────────────

class ScriptedModel {
  readonly calls: ModelRequest[] = [];
  private readonly responses: Array<string | { correct: boolean }>;
  private i = 0;
  readonly modelId: string;

  constructor(responses: Array<string | { correct: boolean }>, modelId = "mock-model") {
    this.responses = responses;
    this.modelId = modelId;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const r = this.responses[this.i++];
    if (r === undefined)
      throw new Error(
        `ScriptedModel: no response #${this.i} (${this.responses.length} total)`,
      );

    if (typeof r === "string") {
      return {
        content: [{ type: "text", text: r }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    } else {
      return {
        content: [{ type: "text", text: JSON.stringify(r) }],
        object: r,
        usage: { inputTokens: 8, outputTokens: 4 },
      };
    }
  }
}

// ── Date parsing tests ─────────────────────────────────────────────────────────

describe("parseLmeDateTimeString", () => {
  it("parses standard LongMemEval date format", () => {
    const ms = parseLmeDateTimeString("2023/05/20 (Sat) 02:36");
    expect(ms).toBeGreaterThan(0);
    // Verify the parsed ms is somewhere within the expected 24-hour window (May 20 UTC)
    // We use a 2-day window to be robust across all timezone offsets.
    const may19 = Date.parse("2023-05-19T00:00:00Z");
    const may21 = Date.parse("2023-05-21T23:59:59Z");
    expect(ms).toBeGreaterThanOrEqual(may19);
    expect(ms).toBeLessThanOrEqual(may21);
  });

  it("returns 0 for empty string", () => {
    expect(parseLmeDateTimeString("")).toBe(0);
  });

  it("returns 0 for unparseable string", () => {
    expect(parseLmeDateTimeString("not a date at all!!")).toBe(0);
  });

  it("preserves chronological order when parsing multiple dates", () => {
    const d1 = parseLmeDateTimeString("2023/05/10 (Wed) 09:00");
    const d2 = parseLmeDateTimeString("2023/05/15 (Mon) 11:30");
    const d3 = parseLmeDateTimeString("2023/05/20 (Sat) 16:00");
    expect(d1).toBeLessThan(d2);
    expect(d2).toBeLessThan(d3);
  });
});

// ── Loader tests ───────────────────────────────────────────────────────────────

describe("loadLongMemEval — real schema (fixture)", () => {
  it("loads the fixture and returns typed questions", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    expect(ds.questions).toHaveLength(4);
  });

  it("parses question ids, types, questions, and answers", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    expect(q0.id).toBe("lme-fixture-001");
    expect(q0.type).toBe("single-session-user");
    expect(q0.baseType).toBe("single-session-user");
    expect(q0.isAbstention).toBe(false);
    expect(q0.question).toBe("What instrument does the user play?");
    expect(q0.answer).toBe("guitar");
  });

  it("parses question_date to epoch ms", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    expect(q0.questionDate).toBe("2023/05/22 (Mon) 14:00");
    expect(q0.questionDateMs).toBeGreaterThan(0);
    // Verify the parsed ms is within the 2023-05-22 window (robust to all timezones)
    const may21 = Date.parse("2023-05-21T00:00:00Z");
    const may23 = Date.parse("2023-05-23T23:59:59Z");
    expect(q0.questionDateMs).toBeGreaterThanOrEqual(may21);
    expect(q0.questionDateMs).toBeLessThanOrEqual(may23);
  });

  it("parses sessions in chronological order", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    expect(q0.sessions).toHaveLength(3);
    // Sessions should be sorted by dateTimeMs ascending
    const ms = q0.sessions.map((s) => s.dateTimeMs);
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]!);
    }
  });

  it("parses session ids and dates", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    const sess0 = q0.sessions[0]!;
    expect(sess0.id).toBe("session_001_a");
    expect(sess0.dateTime).toBe("2023/05/10 (Wed) 09:00");
    expect(sess0.dateTimeMs).toBeGreaterThan(0);
  });

  it("parses session turns with role and content", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    const sess0 = q0.sessions[0]!;
    expect(sess0.turns).toHaveLength(2);
    expect(sess0.turns[0]!.role).toBe("user");
    expect(sess0.turns[0]!.content).toContain("guitar since I was twelve");
    expect(sess0.turns[1]!.role).toBe("assistant");
  });

  it("detects abstention variants (type ends with _abs)", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const absQ = ds.questions.find((q) => q.id === "lme-fixture-003")!;
    expect(absQ.isAbstention).toBe(true);
    expect(absQ.type).toBe("knowledge-update_abs");
    expect(absQ.baseType).toBe("knowledge-update");
  });

  it("non-abstention questions have isAbstention=false", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const regular = ds.questions.filter((q) => !q.isAbstention);
    expect(regular.length).toBe(3);
    for (const q of regular) {
      expect(q.isAbstention).toBe(false);
    }
  });

  it("parses answerSessionIds", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    expect(q0.answerSessionIds).toEqual(["session_001_a"]);
    const q3 = ds.questions[3]!;
    expect(q3.answerSessionIds).toEqual(["session_001_a", "session_001_c"]);
  });

  it("throws when file does not exist", async () => {
    await expect(loadLongMemEval("/tmp/does-not-exist-lme.json")).rejects.toThrow(
      /cannot stat|ENOENT/i,
    );
  });

  it("throws when file exceeds maxBytes cap", async () => {
    await expect(loadLongMemEval(FIXTURE_PATH, { maxBytes: 1 })).rejects.toThrow(
      /cap|MiB|exceeds/i,
    );
  });

  it("throws when root is not an array", async () => {
    const tmpDir = join(tmpdir(), `lme-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, JSON.stringify({ data: [] }), "utf-8");
    await expect(loadLongMemEval(p)).rejects.toThrow(/expected the LongMemEval JSON root to be an array/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Harness end-to-end tests (fixture + MockModel) ────────────────────────────

function makeTestMemory(): Memory {
  return new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: new FakeEmbedder(32),
  });
}

describe("runLongMemEvalBench — end-to-end with MockModel", () => {
  it("runs in full-context mode and returns a report", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    // 4 questions: 3 regular + 1 abstention
    // For each: answer model response + judge response
    const scripted: Array<string | { correct: boolean }> = [
      "guitar",              // q1 answer
      { correct: true },
      "10 days",             // q2 answer
      { correct: true },
      "No information available", // q3 abstention answer
      { correct: true },
      "playing guitar since age twelve, performed at a small local venue", // q4 answer
      { correct: true },
    ];

    const answerModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 0),
      "test-answer",
    );
    const judgeModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 1),
      "test-judge",
    );

    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "full-context",
    });

    expect(report.config.mode).toBe("full-context");
    expect(report.config.answerModelId).toBe("test-answer");
    expect(report.config.judgeModelId).toBe("test-judge");
    expect(report.questions.length).toBe(4);
    // 3 regular questions
    expect(report.overall.total).toBe(3);
    expect(report.overall.correct).toBe(3);
    expect(report.overall.accuracy).toBeCloseTo(1.0);
    // 1 abstention
    expect(report.abstentionAccuracy).toBeDefined();
    expect(report.abstentionAccuracy!.total).toBe(1);
    expect(report.abstentionAccuracy!.correct).toBe(1);
  });

  it("runs in memory mode with memoryFactory", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const scripted: Array<string | { correct: boolean }> = [
      "guitar",
      { correct: true },
      "10 days",
      { correct: true },
      "No information available",
      { correct: true },
      "age twelve",
      { correct: true },
    ];

    const answerModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 0),
      "mem-answer",
    );
    const judgeModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 1),
      "mem-judge",
    );

    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "memory",
      memoryFactory: () => makeTestMemory(),
    });

    expect(report.config.mode).toBe("memory");
    expect(report.questions.length).toBe(4);
  });

  it("computes exact metrics math for scripted fixture", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    // Only non-abstention questions: 3 questions
    // Script: correct, wrong, correct → 2/3 = 66.7%
    const scripted: Array<string | { correct: boolean }> = [
      "guitar",
      { correct: true },
      "5 days",     // wrong answer
      { correct: false },
      "local venue",
      { correct: true },
    ];

    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0));
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1));

    // Filter to only non-abstention types
    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "full-context",
      types: ["single-session-user", "temporal-reasoning", "multi-session"],
    });

    expect(report.overall.total).toBe(3);
    expect(report.overall.correct).toBe(2);
    expect(report.overall.accuracy).toBeCloseTo(2 / 3);
    expect(report.abstentionAccuracy).toBeUndefined(); // no abstention types in filter
  });

  it("handles abstention questions correctly — model abstains = correct", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const absQ = ds.questions.find((q) => q.isAbstention)!;
    const scripted: Array<string | { correct: boolean }> = [
      "No information available",
      { correct: true },
    ];

    const answerModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 0),
    );
    const judgeModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 1),
    );

    const report = await runLongMemEvalBench({
      dataset: { questions: [absQ] },
      answerModel,
      judgeModel,
      mode: "full-context",
    });

    expect(report.abstentionAccuracy).toBeDefined();
    expect(report.abstentionAccuracy!.total).toBe(1);
    expect(report.abstentionAccuracy!.correct).toBe(1);
    expect(report.overall.total).toBe(0); // no regular questions
  });

  it("handles abstention questions correctly — model fabricates = wrong", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const absQ = ds.questions.find((q) => q.isAbstention)!;
    const scripted: Array<string | { correct: boolean }> = [
      "The user prefers jazz music.",  // fabricated concrete answer
      { correct: false },
    ];

    const answerModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 0),
    );
    const judgeModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 1),
    );

    const report = await runLongMemEvalBench({
      dataset: { questions: [absQ] },
      answerModel,
      judgeModel,
      mode: "full-context",
    });

    expect(report.abstentionAccuracy!.correct).toBe(0);
    expect(report.abstentionAccuracy!.total).toBe(1);
    expect(report.abstentionAccuracy!.accuracy).toBeCloseTo(0);
  });

  it("counts errors without aborting the run", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const throwingModel = {
      modelId: "throw-model",
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("network timeout");
      },
    };
    const judgeModel = new ScriptedModel([], "judge");

    const report = await runLongMemEvalBench({
      dataset: { questions: [ds.questions[0]!] },
      answerModel: throwingModel,
      judgeModel,
      mode: "full-context",
    });

    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.questions.length).toBeGreaterThan(0);
    expect(report.overall.correct).toBe(0);
  });

  it("tracks token usage correctly", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!; // single-session-user, not abstention
    const answerModel = new ScriptedModel(["guitar"], "ans"); // 10 in, 5 out
    const judgeModel = new ScriptedModel([{ correct: true }], "jdg"); // 8 in, 4 out

    const report = await runLongMemEvalBench({
      dataset: { questions: [q0] },
      answerModel,
      judgeModel,
      mode: "full-context",
    });

    const row = report.questions[0]!;
    expect(row.answerInputTokens).toBe(10);
    expect(row.answerOutputTokens).toBe(5);
    expect(row.judgeInputTokens).toBe(8);
    expect(row.judgeOutputTokens).toBe(4);
    expect(report.tokens.answerInputTokens).toBe(10);
    expect(report.tokens.judgeInputTokens).toBe(8);
    expect(report.tokens.totalInputTokens).toBe(18);
  });

  it("applies questionLimit with seeded shuffle", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    // 4 questions; limit to 2
    const scripted: Array<string | { correct: boolean }> = [
      "some answer",
      { correct: true },
      "some answer",
      { correct: true },
    ];
    const answerModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 0),
    );
    const judgeModel = new ScriptedModel(
      scripted.filter((_, i) => i % 2 === 1),
    );

    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "full-context",
      questionLimit: 2,
      seed: 42,
    });

    expect(report.questions.length).toBe(2);
  });

  it("throws when mode=memory and memoryFactory is missing", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    await expect(
      runLongMemEvalBench({
        dataset: { questions: [ds.questions[0]!] },
        answerModel: new ScriptedModel([]),
        judgeModel: new ScriptedModel([]),
        mode: "memory",
        // no memoryFactory
      }),
    ).rejects.toThrow(/memoryFactory/i);
  });

  it("throws when neither dataPath nor dataset is provided", async () => {
    await expect(
      runLongMemEvalBench({
        answerModel: new ScriptedModel([]),
        judgeModel: new ScriptedModel([]),
        mode: "full-context",
      }),
    ).rejects.toThrow(/dataPath or dataset/i);
  });
});

// ── Checkpoint resume tests ────────────────────────────────────────────────────

describe("runLongMemEvalBench — checkpoint resume", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `lme-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes checkpoint rows and skips them on resume", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const checkpointPath = join(tmpDir, "checkpoint.jsonl");
    const q0 = ds.questions[0]!;

    // First run: 1 question
    const run1Answer = new ScriptedModel(["guitar"], "ans");
    const run1Judge = new ScriptedModel([{ correct: true }], "jdg");

    await runLongMemEvalBench({
      dataset: { questions: [q0] },
      answerModel: run1Answer,
      judgeModel: run1Judge,
      mode: "full-context",
      checkpointPath,
    });

    // Verify checkpoint was written
    const content = await readFile(checkpointPath, "utf-8");
    const rows = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].questionId).toBe("lme-fixture-001");

    // Second run: answer model has NO responses (must not be called — already checkpointed)
    const run2Answer = new ScriptedModel([], "ans2");
    const run2Judge = new ScriptedModel([], "jdg2");

    const report2 = await runLongMemEvalBench({
      dataset: { questions: [q0] },
      answerModel: run2Answer,
      judgeModel: run2Judge,
      mode: "full-context",
      checkpointPath,
    });

    expect(run2Answer.calls.length).toBe(0);
    expect(report2.questions.length).toBeGreaterThan(0);
  });
});

// ── Per-type accuracy breakdown tests ─────────────────────────────────────────

describe("runLongMemEvalBench — per-type metrics", () => {
  it("groups results by base type (strips _abs suffix)", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const scripted: Array<string | { correct: boolean }> = [
      "guitar",
      { correct: true },
      "10 days",
      { correct: false },
      "No information available",
      { correct: true },
      "local venue",
      { correct: true },
    ];

    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 0)),
      judgeModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 1)),
      mode: "full-context",
    });

    // single-session-user: 1 correct / 1 total
    expect(report.byType["single-session-user"]).toBeDefined();
    expect(report.byType["single-session-user"]!.total).toBe(1);
    expect(report.byType["single-session-user"]!.correct).toBe(1);

    // temporal-reasoning: 1 wrong / 1 total
    expect(report.byType["temporal-reasoning"]).toBeDefined();
    expect(report.byType["temporal-reasoning"]!.total).toBe(1);
    expect(report.byType["temporal-reasoning"]!.correct).toBe(0);

    // knowledge-update: abstention — NOT in byType, in abstentionAccuracy
    expect(report.byType["knowledge-update"]).toBeUndefined();
    expect(report.abstentionAccuracy!.total).toBe(1);

    // multi-session: 1 correct / 1 total
    expect(report.byType["multi-session"]!.total).toBe(1);
    expect(report.byType["multi-session"]!.correct).toBe(1);

    // overall: 3 regular questions, 2 correct
    expect(report.overall.total).toBe(3);
    expect(report.overall.correct).toBe(2);
    expect(report.overall.accuracy).toBeCloseTo(2 / 3);
  });
});

// ── Markdown renderer tests ────────────────────────────────────────────────────

describe("renderLongMemEvalReportMarkdown", () => {
  it("renders a markdown table with required columns", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const scripted: Array<string | { correct: boolean }> = ds.questions.flatMap((q) => [
      q.isAbstention ? "No information available" : (q.answer ?? "answer"),
      { correct: true },
    ] as Array<string | { correct: boolean }>);

    const report = await runLongMemEvalBench({
      dataset: ds,
      answerModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 0), "gpt-test"),
      judgeModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 1), "gpt-judge"),
      mode: "full-context",
    });

    const md = renderLongMemEvalReportMarkdown([report]);

    expect(md).toContain("LongMemEval Benchmark Results");
    expect(md).toContain("Overall accuracy");
    expect(md).toContain("Abstention accuracy");
    expect(md).toContain("Answer model");
    expect(md).toContain("Judge model");
    expect(md).toContain("Dataset provenance");
    expect(md).toContain("Methodology Notes");
    expect(md).toContain("full-context");
  });

  it("renders 'No results yet' for empty reports array", () => {
    const md = renderLongMemEvalReportMarkdown([]);
    expect(md).toContain("No results yet");
  });

  it("includes cost estimate when price table is provided", async () => {
    const ds = await loadLongMemEval(FIXTURE_PATH);
    const q0 = ds.questions[0]!;
    const report = await runLongMemEvalBench({
      dataset: { questions: [q0] },
      answerModel: new ScriptedModel([q0.answer], "test-ans"),
      judgeModel: new ScriptedModel([{ correct: true }], "test-jdg"),
      mode: "full-context",
    });

    const md = renderLongMemEvalReportMarkdown([report], {
      inputPer1M: 0.15,
      outputPer1M: 0.6,
    });
    expect(md).toMatch(/\$\d+\.\d{4}/);
  });
});

// ── Gated integration test: real data/longmemeval_s.json ──────────────────────

const RUN_LME = process.env["EIDENTIC_TEST_LME"] === "1";
const LME_PATH = resolve(process.cwd(), "data/longmemeval_s.json");

describe("LongMemEval integration test — real dataset (gated)", () => {
  it.skipIf(!RUN_LME)(
    "loads data/longmemeval_s.json and asserts correct dataset stats",
    async () => {
      const ds = await loadLongMemEval(LME_PATH);

      // Verify total question count
      expect(ds.questions).toHaveLength(500);

      // Per-type distribution
      const byType: Record<string, number> = {};
      for (const q of ds.questions) {
        const k = q.type;
        byType[k] = (byType[k] ?? 0) + 1;
      }

      // Standard longmemeval_s.json type distribution (verified from real file)
      expect(byType["single-session-user"]).toBe(70);
      expect(byType["single-session-assistant"]).toBe(56);
      expect(byType["single-session-preference"]).toBe(30);
      expect(byType["multi-session"]).toBe(133);
      expect(byType["temporal-reasoning"]).toBe(133);
      expect(byType["knowledge-update"]).toBe(78);

      // No abstention variants in the standard _s split
      const abstentionCount = ds.questions.filter((q) => q.isAbstention).length;
      expect(abstentionCount).toBe(0);

      // Average haystack sessions
      const avgSessions =
        ds.questions.reduce((sum, q) => sum + q.sessions.length, 0) / ds.questions.length;
      console.info("[LME integration] total questions:", ds.questions.length);
      console.info("[LME integration] by type:", byType);
      console.info("[LME integration] avg haystack sessions:", avgSessions.toFixed(1));

      // All questions have sessions and a question date
      for (const q of ds.questions) {
        expect(q.sessions.length).toBeGreaterThan(0);
        expect(q.questionDate).toBeTruthy();
      }
    },
    60_000,
  );
});
