/**
 * Unit + integration tests for the LoCoMo loader, harness, and markdown renderer.
 *
 * Tests are fixture-based (no network, no real LLM) except the gated integration test
 * at the bottom which requires EIDENTIC_TEST_LOCOMO=1 and data/locomo10.json.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import type { ModelRequest, ModelResponse } from "@eidentic/types";
import { InMemoryStore, FakeEmbedder, InMemoryVectorStore } from "@eidentic/types/testing";
import { Memory } from "@eidentic/memory";
import { loadLoCoMo } from "../src/locomo-loader.js";
import { resolveEvidence } from "../src/locomo-types.js";
import { runLocomoBench } from "../src/locomo-run.js";
import { renderLocomoReportMarkdown } from "../src/locomo-render.js";
import type { LocomoReport } from "../src/locomo-run.js";

// Path to the fixture file (committed — synthetic content we own)
const FIXTURE_PATH = resolve(__dirname, "fixtures/locomo-fixture.json");

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
    if (r === undefined) throw new Error(`ScriptedModel: no response #${this.i} (${this.responses.length} total)`);

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

// ── Loader tests ──────────────────────────────────────────────────────────────

describe("loadLoCoMo — real schema (fixture)", () => {
  it("loads the fixture and returns typed samples", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    expect(ds.samples).toHaveLength(2);
    expect(ds.samples[0]!.sampleId).toBe("fixture-001");
    expect(ds.samples[1]!.sampleId).toBe("fixture-002");
  });

  it("parses speaker names correctly", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    expect(ds.samples[0]!.speakerA).toBe("Alice");
    expect(ds.samples[0]!.speakerB).toBe("Bob");
  });

  it("parses dynamic session keys into ordered sessions", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const sample = ds.samples[0]!;
    expect(sample.sessions).toHaveLength(2);
    expect(sample.sessions[0]!.index).toBe(1);
    expect(sample.sessions[1]!.index).toBe(2);
  });

  it("parses session turns with diaId and speaker", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const sess1 = ds.samples[0]!.sessions[0]!;
    expect(sess1.turns).toHaveLength(3);
    expect(sess1.turns[0]!.diaId).toBe("D1:1");
    expect(sess1.turns[0]!.speaker).toBe("Alice");
    expect(sess1.turns[0]!.text).toBe("Hey Bob! I just got a new job at TechCorp.");
  });

  it("parses session dateTime strings", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const sess1 = ds.samples[0]!.sessions[0]!;
    expect(sess1.dateTime).toBe("10:00 am on 1 March, 2023");
    // dateTimeMs should be a positive epoch value
    expect(sess1.dateTimeMs).toBeGreaterThan(0);
  });

  it("parses QA with correct types and evidence", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const qa = ds.samples[0]!.qa;
    expect(qa).toHaveLength(6);

    const singleHop = qa.find((q) => q.question === "Where does Alice work?");
    expect(singleHop?.category).toBe(4);
    expect(singleHop?.answer).toBe("TechCorp");
    expect(singleHop?.evidence).toEqual(["D1:1"]);

    const multiHop = qa.find((q) => q.question === "What is Alice's manager's name at TechCorp?");
    expect(multiHop?.category).toBe(1);
    expect(multiHop?.evidence).toEqual(["D1:1", "D2:2"]);
  });

  it("parses adversarial category-5 questions", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const cat5 = ds.samples[0]!.qa.filter((q) => q.category === 5);
    expect(cat5).toHaveLength(2);
    expect(cat5[0]!.answer).toBeUndefined();
    expect(cat5[0]!.adversarialAnswer).toBe("San Francisco");
  });

  it("covers all 5 categories in the fixture", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const allQA = ds.samples.flatMap((s) => s.qa);
    const cats = new Set(allQA.map((q) => q.category));
    expect(cats).toContain(1);
    expect(cats).toContain(2);
    expect(cats).toContain(3);
    expect(cats).toContain(4);
    expect(cats).toContain(5);
  });

  it("throws when file does not exist", async () => {
    await expect(loadLoCoMo("/tmp/does-not-exist-locomo.json")).rejects.toThrow(
      /cannot stat|ENOENT/i,
    );
  });

  it("throws when file exceeds maxBytes cap", async () => {
    await expect(loadLoCoMo(FIXTURE_PATH, { maxBytes: 1 })).rejects.toThrow(
      /cap|MiB|exceeds/i,
    );
  });

  it("throws when root is not an array", async () => {
    let tmpDir: string;
    tmpDir = join(tmpdir(), `locomo-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, JSON.stringify({ data: [] }), "utf-8");
    await expect(loadLoCoMo(p)).rejects.toThrow(/expected the LoCoMo JSON root to be an array/i);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── resolveEvidence tests ──────────────────────────────────────────────────────

describe("resolveEvidence", () => {
  it("resolves dia-ids to turn texts", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const sample = ds.samples[0]!;
    const texts = resolveEvidence(sample, ["D1:1", "D2:2"]);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("TechCorp");
    expect(texts[1]).toContain("Sarah");
  });

  it("silently skips unmatched ids", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const sample = ds.samples[0]!;
    const texts = resolveEvidence(sample, ["D1:1", "D99:99"]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("TechCorp");
  });

  it("returns empty array for empty ids", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const texts = resolveEvidence(ds.samples[0]!, []);
    expect(texts).toHaveLength(0);
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

describe("runLocomoBench — end-to-end with MockModel", () => {
  it("runs in full-context mode and returns a report", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    // 10 questions across 2 samples
    // Answers: 2 correct (string), 1 vague→judged wrong, 1 cat5 refusal correct, 1 cat5 trap wrong
    // + 5 more for fixture-002
    // For simplicity: all answer calls return "TechCorp" / judge alternates correct/wrong
    const allQA = ds.samples.flatMap((s) => s.qa); // 10 total
    // Build scripted responses: alternating answer + judge
    const scripted: Array<string | { correct: boolean }> = [];
    for (const qa of allQA) {
      if (qa.category === 5) {
        scripted.push("No information available"); // decline = correct for cat5
        scripted.push({ correct: true });
      } else {
        scripted.push(qa.answer ?? "some answer");
        scripted.push({ correct: true });
      }
    }

    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0), "test-answer");
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1), "test-judge");

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "full-context",
      categories: [1, 2, 3, 4, 5],
    });

    expect(report.config.mode).toBe("full-context");
    expect(report.config.answerModelId).toBe("test-answer");
    expect(report.config.judgeModelId).toBe("test-judge");
    expect(report.questions.length).toBeGreaterThan(0);
    expect(report.overallJ14.total).toBeGreaterThan(0);
    expect(report.overallJ14.accuracy).toBeGreaterThanOrEqual(0);
    expect(report.overallJ14.accuracy).toBeLessThanOrEqual(1);
  });

  it("runs in memory mode with memoryFactory", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const allQA = ds.samples.flatMap((s) => s.qa);
    const scripted: Array<string | { correct: boolean }> = [];
    for (const qa of allQA) {
      scripted.push(qa.category === 5 ? "No information available" : (qa.answer ?? "answer"));
      scripted.push({ correct: true });
    }

    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0), "mem-answer");
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1), "mem-judge");

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: ds,
      answerModel,
      judgeModel,
      mode: "memory",
      memoryFactory: () => makeTestMemory(),
      categories: [1, 2, 3, 4, 5],
    });

    expect(report.config.mode).toBe("memory");
    expect(report.questions.length).toBeGreaterThan(0);
  });

  it("computes exact metrics math for scripted fixture", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    // Run only cat1–4 from sample fixture-001 (4 questions: cat4, cat2, cat1, cat3)
    // Scripted: 2 correct, 1 wrong, 1 correct → 3/4 = 75%
    const scripted: Array<string | { correct: boolean }> = [
      "TechCorp",          // answer
      { correct: true },   // judge → correct
      "wrong date",        // answer
      { correct: false },  // judge → wrong
      "Sarah",             // answer
      { correct: true },   // judge → correct
      "excited",           // answer
      { correct: true },   // judge → correct
    ];

    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0));
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1));

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel,
      judgeModel,
      mode: "full-context",
      categories: [1, 2, 3, 4],
      sampleLimit: 1,
    });

    expect(report.overallJ14.total).toBe(4);
    expect(report.overallJ14.correct).toBe(3);
    expect(report.overallJ14.accuracy).toBeCloseTo(0.75);
    expect(report.cat5RefusalRate).toBeUndefined(); // no cat5 requested
  });

  it("handles category-5 adversarial trap detection", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    // Test cat5 only from sample fixture-001 (2 questions)
    // Q1: model returns the adversarial trap → wrong
    // Q2: model declines → correct
    const scripted: Array<string | { correct: boolean }> = [
      "San Francisco",     // trap answer for Q1
      { correct: false },  // judge says wrong
      "No information available", // decline for Q2
      { correct: true },   // judge says correct (model declined)
    ];

    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0));
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1));

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel,
      judgeModel,
      mode: "full-context",
      categories: [5],
      sampleLimit: 1,
    });

    expect(report.cat5RefusalRate).toBeDefined();
    expect(report.cat5RefusalRate!.total).toBe(2);
    expect(report.cat5RefusalRate!.correct).toBe(1);
    expect(report.cat5RefusalRate!.rate).toBeCloseTo(0.5);
    // overallJ14 should have 0 total (no cat 1-4 run)
    expect(report.overallJ14.total).toBe(0);
  });

  it("counts errors without aborting the run", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    // Only cat4 from fixture-001: 1 question ("Where does Alice work?")
    // Make the answer model throw
    const throwingModel = {
      modelId: "throw-model",
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("network error");
      },
    };
    const judgeModel = new ScriptedModel([], "judge");

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel: throwingModel,
      judgeModel,
      mode: "full-context",
      categories: [4],
    });

    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.questions.length).toBeGreaterThan(0);
    // All questions counted as wrong (not skipped)
    expect(report.overallJ14.correct).toBe(0);
  });

  it("tracks token usage", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    // Run 1 cat4 question with known token counts
    const answerModel = new ScriptedModel(["TechCorp"], "ans"); // 10 in, 5 out
    const judgeModel = new ScriptedModel([{ correct: true }], "jdg"); // 8 in, 4 out

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel,
      judgeModel,
      mode: "full-context",
      categories: [4],
      sampleLimit: 1,
    });

    const q = report.questions[0]!;
    expect(q.answerInputTokens).toBe(10);
    expect(q.answerOutputTokens).toBe(5);
    expect(q.judgeInputTokens).toBe(8);
    expect(q.judgeOutputTokens).toBe(4);
    expect(report.tokens.answerInputTokens).toBe(10);
    expect(report.tokens.judgeInputTokens).toBe(8);
    expect(report.tokens.totalInputTokens).toBe(18); // 10 + 8
  });
});

// ── Checkpoint resume tests ────────────────────────────────────────────────────

describe("runLocomoBench — checkpoint resume", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `locomo-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes checkpoint rows and skips them on resume", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const checkpointPath = join(tmpDir, "checkpoint.jsonl");

    // First run: only cat4 from fixture-001 (1 question)
    const run1Answer = new ScriptedModel(["TechCorp"], "ans");
    const run1Judge = new ScriptedModel([{ correct: true }], "jdg");

    await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel: run1Answer,
      judgeModel: run1Judge,
      mode: "full-context",
      categories: [4],
      checkpointPath,
    });

    // Verify checkpoint was written
    const content = await readFile(checkpointPath, "utf-8");
    const rows = content.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThan(0);
    const ckptRow = rows[0];
    expect(ckptRow.sampleId).toBe("fixture-001");

    // Second run: answer model has NO responses (it must not be called — already checkpointed)
    const run2Answer = new ScriptedModel([], "ans2");
    const run2Judge = new ScriptedModel([], "jdg2");

    const report2 = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel: run2Answer,
      judgeModel: run2Judge,
      mode: "full-context",
      categories: [4],
      checkpointPath,
    });

    // The answer model should not have been called (run2Answer has 0 scripted responses and no calls)
    expect(run2Answer.calls.length).toBe(0);
    // Results should include the checkpointed row
    expect(report2.questions.length).toBeGreaterThan(0);
  });
});

// ── Markdown renderer tests ────────────────────────────────────────────────────

describe("renderLocomoReportMarkdown", () => {
  it("renders a markdown table with required columns", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const allQA = ds.samples[0]!.qa.filter((q) => q.category !== 5);
    const scripted: Array<string | { correct: boolean }> = allQA.flatMap((q) => [
      q.answer ?? "answer",
      { correct: true },
    ]);
    const answerModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 0), "gpt-test");
    const judgeModel = new ScriptedModel(scripted.filter((_, i) => i % 2 === 1), "gpt-judge");

    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel,
      judgeModel,
      mode: "full-context",
      categories: [1, 2, 3, 4],
    });

    const md = renderLocomoReportMarkdown([report]);

    expect(md).toContain("LoCoMo Benchmark Results");
    expect(md).toContain("J(1–4)");
    expect(md).toContain("Cat5 refusal rate");
    expect(md).toContain("Judge model");
    expect(md).toContain("Dataset SHA");
    expect(md).toContain("Methodology Notes");
    expect(md).toContain("full-context");
  });

  it("renders 'No results yet' for empty reports array", () => {
    const md = renderLocomoReportMarkdown([]);
    expect(md).toContain("No results yet");
  });

  it("includes cost estimate when price table is provided", async () => {
    const ds = await loadLoCoMo(FIXTURE_PATH);
    const allQA = ds.samples[0]!.qa.filter((q) => q.category === 4);
    const scripted = allQA.flatMap((q) => [q.answer ?? "ans", { correct: true }] as Array<string | { correct: boolean }>);
    const report = await runLocomoBench({
      dataPath: FIXTURE_PATH,
      dataset: { samples: [ds.samples[0]!] },
      answerModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 0)),
      judgeModel: new ScriptedModel(scripted.filter((_, i) => i % 2 === 1)),
      mode: "full-context",
      categories: [4],
    });

    const md = renderLocomoReportMarkdown([report], { inputPer1M: 3.0, outputPer1M: 15.0 });
    expect(md).toMatch(/\$\d+\.\d{4}/); // "$0.0003" style cost
  });
});

// ── Gated integration test: real data/locomo10.json ───────────────────────────

const RUN_LOCOMO = process.env["EIDENTIC_TEST_LOCOMO"] === "1";
const LOCOMO_PATH = resolve(process.cwd(), "data/locomo10.json");

describe("LoCoMo integration test — real dataset (gated)", () => {
  it.skipIf(!RUN_LOCOMO)(
    "loads data/locomo10.json and asserts correct dataset stats",
    async () => {
      const ds = await loadLoCoMo(LOCOMO_PATH);

      // Verify sample count
      expect(ds.samples).toHaveLength(10);

      // Verify total QA count and category distribution
      const allQA = ds.samples.flatMap((s) => s.qa);
      expect(allQA.length).toBe(1986);

      const byCat: Record<string, number> = {};
      for (const q of allQA) {
        const k = String(q.category);
        byCat[k] = (byCat[k] ?? 0) + 1;
      }

      // Category distribution (as observed in the file — trust the file)
      expect(byCat["1"]).toBe(282);   // multi-hop
      expect(byCat["2"]).toBe(321);   // temporal
      expect(byCat["3"]).toBe(96);    // open-domain
      expect(byCat["4"]).toBe(841);   // single-hop
      expect(byCat["5"]).toBe(446);   // adversarial

      // Cat 1-4 total must be exactly 1540
      const cat14Total = (byCat["1"] ?? 0) + (byCat["2"] ?? 0) + (byCat["3"] ?? 0) + (byCat["4"] ?? 0);
      expect(cat14Total).toBe(1540);

      // Cat 5 must be 446
      expect(byCat["5"]).toBe(446);

      // Log actual stats for the CI record
      console.info("[LoCoMo integration] samples:", ds.samples.length);
      console.info("[LoCoMo integration] total QA:", allQA.length);
      console.info("[LoCoMo integration] by category:", byCat);
      console.info("[LoCoMo integration] cat1-4 total:", cat14Total);
    },
    30_000,
  );
});
