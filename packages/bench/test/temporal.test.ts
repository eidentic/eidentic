/**
 * Tests for the temporal benchmark (runTemporalBench + syntheticTemporalDataset).
 *
 * Covers:
 *   - Dataset generator determinism (seeded)
 *   - Gold-answer correctness (hand-verified question types)
 *   - pointInTimeAccuracy and currentStateAccuracy metrics
 *   - Report shape
 *   - "before first fact" queries returning null
 *   - Boundary (exact validFrom) queries
 *   - Mid-interval queries
 */
import { describe, it, expect } from "vitest";
import { Memory } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";
import { syntheticTemporalDataset } from "../src/datasets/temporal.js";
import { runTemporalBench } from "../src/temporal.js";

function makeGraphMemory(): Memory {
  const store = new InMemoryStore();
  return new Memory({ store, graph: store });
}

// ── Dataset generator determinism ──────────────────────────────────────────────────────────────

describe("syntheticTemporalDataset — determinism", () => {
  it("same seed produces identical output (entities, asserts, questions)", () => {
    const a = syntheticTemporalDataset({ seed: 42, entityCount: 3 });
    const b = syntheticTemporalDataset({ seed: 42, entityCount: 3 });

    expect(a.entities.length).toBe(b.entities.length);
    expect(a.asserts.length).toBe(b.asserts.length);
    expect(a.questions.length).toBe(b.questions.length);

    // Deep-compare key fields
    for (let i = 0; i < a.asserts.length; i++) {
      expect(a.asserts[i]!.subject).toBe(b.asserts[i]!.subject);
      expect(a.asserts[i]!.predicate).toBe(b.asserts[i]!.predicate);
      expect(a.asserts[i]!.object).toBe(b.asserts[i]!.object);
      expect(a.asserts[i]!.validFrom).toBe(b.asserts[i]!.validFrom);
    }

    for (let i = 0; i < a.questions.length; i++) {
      expect(a.questions[i]!.goldAnswer).toBe(b.questions[i]!.goldAnswer);
      expect(a.questions[i]!.askedAt).toBe(b.questions[i]!.askedAt);
    }
  });

  it("different seeds produce different outputs", () => {
    const a = syntheticTemporalDataset({ seed: 1, entityCount: 2 });
    const b = syntheticTemporalDataset({ seed: 999, entityCount: 2 });

    // Not all asserts will differ (subjects are stable) but objects should differ
    const aObjects = a.asserts.map((x) => x.object).join(",");
    const bObjects = b.asserts.map((x) => x.object).join(",");
    expect(aObjects).not.toBe(bObjects);
  });

  it("produces correct entity count", () => {
    const ds = syntheticTemporalDataset({ entityCount: 2, seed: 7 });
    expect(ds.entities.length).toBe(2);
  });

  it("produces correct assert count: entityCount × properties × changesPerProperty", () => {
    const entityCount = 2;
    const changesPerProperty = 3;
    const propertyCount = 4; // employer, city, preferred_language, role
    const ds = syntheticTemporalDataset({ entityCount, seed: 1, changesPerProperty });
    expect(ds.asserts.length).toBe(entityCount * propertyCount * changesPerProperty);
  });

  it("asserts per (subject, predicate) pair are sorted by validFrom ascending", () => {
    const ds = syntheticTemporalDataset({ seed: 42 });
    // Group by (subject, predicate) and verify each group is ordered
    const groups = new Map<string, string[]>();
    for (const a of ds.asserts) {
      const key = `${a.subject}::${a.predicate}`;
      const list = groups.get(key) ?? [];
      list.push(a.validFrom ?? "");
      groups.set(key, list);
    }
    for (const [, vfs] of groups) {
      for (let i = 1; i < vfs.length; i++) {
        expect(vfs[i]! >= vfs[i - 1]!).toBe(true);
      }
    }
  });

  it("goldAnswer = null only for before-first-fact questions", () => {
    const ds = syntheticTemporalDataset({ seed: 42 });
    const nullGold = ds.questions.filter((q) => q.goldAnswer === null);
    // Every before-first-fact question has askedAt before any known fact
    for (const q of nullGold) {
      // Null means asked before any data → askedAt should be less than 2022
      expect(q.askedAt < "2022-01-01T00:00:00.000Z").toBe(true);
    }
  });

  it("dataset has a name containing the seed", () => {
    const ds = syntheticTemporalDataset({ seed: 77 });
    expect(ds.name).toContain("seed=77");
  });
});

// ── Gold-answer correctness ────────────────────────────────────────────────────────────────────

describe("syntheticTemporalDataset — gold-answer correctness", () => {
  it("at-boundary question: goldAnswer matches the value asserted at that exact timestamp", () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 1, changesPerProperty: 3 });

    // Find an "at-boundary" question (rationale mentions "exactly")
    const boundaryQ = ds.questions.find((q) => q.rationale.includes("exactly"));
    expect(boundaryQ).toBeDefined();

    // The goldAnswer should match the assert for (subject, predicate) with that validFrom
    const matchingAssert = ds.asserts.find(
      (a) =>
        a.subject === boundaryQ!.subject &&
        a.predicate === boundaryQ!.predicate &&
        a.validFrom === boundaryQ!.askedAt,
    );
    expect(matchingAssert).toBeDefined();
    expect(boundaryQ!.goldAnswer).toBe(matchingAssert!.object);
  });

  it("mid-interval question: goldAnswer matches the value active just before the next transition", () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 1, changesPerProperty: 3 });

    // Find a mid-interval question
    const midQ = ds.questions.find((q) => q.rationale.includes("Between"));
    expect(midQ).toBeDefined();

    // Get all asserts for this (subject, predicate), sorted by validFrom
    const timeline = ds.asserts
      .filter((a) => a.subject === midQ!.subject && a.predicate === midQ!.predicate)
      .sort((a, b) => ((a.validFrom ?? "") < (b.validFrom ?? "") ? -1 : 1));

    expect(timeline.length).toBeGreaterThanOrEqual(2);

    // Find which value is active at midQ.askedAt
    let activeValue: string | null = null;
    for (const a of timeline) {
      if ((a.validFrom ?? "") <= midQ!.askedAt) {
        activeValue = a.object;
      } else {
        break; // validFrom > askedAt → this transition hasn't happened yet
      }
    }
    expect(midQ!.goldAnswer).toBe(activeValue);
  });

  it("current-state question: goldAnswer matches the last transition's value", () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 1, changesPerProperty: 3 });

    const currentQ = ds.questions.find(
      (q) => q.rationale.includes("latest") || q.rationale.includes("last transition"),
    );
    expect(currentQ).toBeDefined();

    // Last value in the timeline for this (subject, predicate)
    const timeline = ds.asserts
      .filter((a) => a.subject === currentQ!.subject && a.predicate === currentQ!.predicate)
      .sort((a, b) => ((a.validFrom ?? "") < (b.validFrom ?? "") ? -1 : 1));

    const lastValue = timeline[timeline.length - 1]?.object;
    expect(currentQ!.goldAnswer).toBe(lastValue);
  });
});

// ── runTemporalBench — report shape ───────────────────────────────────────────────────────────

describe("runTemporalBench — report shape", () => {
  it("produces a TemporalBenchReport with all fields", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report).toBeDefined();
    expect(typeof report.pointInTimeAccuracy).toBe("number");
    expect(typeof report.currentStateAccuracy).toBe("number");
    expect(typeof report.beforeFirstFactAccuracy).toBe("number");
    expect(typeof report.totalQuestions).toBe("number");
    expect(typeof report.llmCallsPerWrite).toBe("number");
    expect(typeof report.tokensUsedIfAny).toBe("number");
    expect(Array.isArray(report.results)).toBe(true);

    expect(report.pointInTimeAccuracy).toBeGreaterThanOrEqual(0);
    expect(report.pointInTimeAccuracy).toBeLessThanOrEqual(1);
    expect(report.currentStateAccuracy).toBeGreaterThanOrEqual(0);
    expect(report.currentStateAccuracy).toBeLessThanOrEqual(1);
    expect(report.beforeFirstFactAccuracy).toBeGreaterThanOrEqual(0);
    expect(report.beforeFirstFactAccuracy).toBeLessThanOrEqual(1);
  });

  it("llmCallsPerWrite = 0 and tokensUsedIfAny = 0 (deterministic benchmark)", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 1 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report.llmCallsPerWrite).toBe(0);
    expect(report.tokensUsedIfAny).toBe(0);
  });

  it("totalQuestions matches dataset.questions.length", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report.totalQuestions).toBe(ds.questions.length);
    expect(report.results.length).toBe(ds.questions.length);
  });

  it("throws when memory has no graph configured", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 1 });
    const memory = new Memory({ store: new InMemoryStore() }); // no graph
    await expect(runTemporalBench(memory, ds)).rejects.toThrow(/graph/i);
  });
});

// ── runTemporalBench — correctness ────────────────────────────────────────────────────────────

describe("runTemporalBench — correctness", () => {
  it("achieves pointInTimeAccuracy = 1.0 on deterministic synthetic dataset", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report.pointInTimeAccuracy).toBe(1.0);
  });

  it("achieves currentStateAccuracy = 1.0 on deterministic synthetic dataset", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report.currentStateAccuracy).toBe(1.0);
  });

  it("achieves beforeFirstFactAccuracy = 1.0 (null answers correctly returned)", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    expect(report.beforeFirstFactAccuracy).toBe(1.0);
  });

  it("all question results have correct=true", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    for (const r of report.results) {
      expect(r.correct).toBe(true);
    }
  });

  it("before-first-fact questions: systemAnswer = null", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    const beforeFirst = report.results.filter((r) => r.questionType === "before-first-fact");
    expect(beforeFirst.length).toBeGreaterThan(0);
    for (const r of beforeFirst) {
      expect(r.systemAnswer).toBeNull();
      expect(r.goldAnswer).toBeNull();
      expect(r.correct).toBe(true);
    }
  });

  it("mid-interval questions: systemAnswer matches goldAnswer (not the later value)", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    const midInterval = report.results.filter((r) => r.questionType === "mid-interval");
    expect(midInterval.length).toBeGreaterThan(0);
    for (const r of midInterval) {
      expect(r.systemAnswer).toBe(r.goldAnswer);
      expect(r.systemAnswer).not.toBeNull();
    }
  });

  it("current-state questions: systemAnswer matches the latest value", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 2 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    const currentState = report.results.filter((r) => r.questionType === "current-state");
    expect(currentState.length).toBeGreaterThan(0);
    for (const r of currentState) {
      expect(r.systemAnswer).toBe(r.goldAnswer);
      expect(r.systemAnswer).not.toBeNull();
    }
  });

  it("results include subject, predicate, askedAt, questionType on every entry", async () => {
    const ds = syntheticTemporalDataset({ seed: 7, entityCount: 1 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    for (const r of report.results) {
      expect(typeof r.subject).toBe("string");
      expect(typeof r.predicate).toBe("string");
      expect(typeof r.askedAt).toBe("string");
      expect(["before-first-fact", "at-boundary", "mid-interval", "current-state"]).toContain(
        r.questionType,
      );
    }
  });
});

// ── Harness-validation numbers ────────────────────────────────────────────────────────────────
//
// These are the real, reproducible, deterministic numbers produced by InMemoryStore + Graph
// (no LLM). They prove the harness works correctly and establish the "infra-free" baseline
// documented in BASELINES.md. Label them clearly as harness-validation numbers, not
// LLM-graded accuracy.

describe("CI baseline — harness-validation numbers (labeled, not LLM-graded)", () => {
  it("seed=42 entityCount=4: all temporal metrics = 1.0 (harness-validation)", async () => {
    const ds = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
    const memory = makeGraphMemory();
    const report = await runTemporalBench(memory, ds);

    // These are deterministic. Any regression breaks the harness.
    expect(report.pointInTimeAccuracy).toBe(1.0);
    expect(report.currentStateAccuracy).toBe(1.0);
    expect(report.beforeFirstFactAccuracy).toBe(1.0);
  });
});
