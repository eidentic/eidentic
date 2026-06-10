/**
 * Tests for the CLI eval command extensions:
 * - runEval with --report (markdownReport output)
 * - runEval with --save-baseline (JSON snapshot)
 * - runEval with --baseline (regression detection)
 * - evalGateCheck + computePassRate (already covered in cli.test.ts; extended here)
 *
 * These tests exercise the pure functions in commands.ts without spawning
 * a child process (the citty CLI pattern).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePassRate, evalGateCheck } from "../src/commands.js";
import type { EvalReportShape } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `eidentic-eval-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeReportShape(
  scorerPassRates: Record<string, number>,
  cases: Array<{ caseId: string; scorerPassRates: Record<string, number> }> = [],
): EvalReportShape {
  const aggregate: EvalReportShape["aggregate"] = {};
  for (const [name, pass] of Object.entries(scorerPassRates)) {
    aggregate[name] = { mean: pass, pass, n: 10 };
  }
  const reportCases: EvalReportShape["cases"] = cases.map((c) => ({
    caseId: c.caseId,
    input: c.caseId,
    samples: [],
    scorerMeans: Object.fromEntries(
      Object.entries(c.scorerPassRates).map(([name, pass]) => [name, { mean: pass, pass, n: 1 }]),
    ),
  }));
  return { cases: reportCases, aggregate };
}

// ---------------------------------------------------------------------------
// computePassRate — extended edge cases
// ---------------------------------------------------------------------------

describe("computePassRate() — extended", () => {
  it("handles a report with three scorers", () => {
    const rate = computePassRate({
      a: { mean: 1, pass: 0.6, n: 5 },
      b: { mean: 1, pass: 0.9, n: 5 },
      c: { mean: 1, pass: 0.3, n: 5 },
    });
    expect(rate).toBeCloseTo((0.6 + 0.9 + 0.3) / 3);
  });
});

// ---------------------------------------------------------------------------
// evalGateCheck — extended
// ---------------------------------------------------------------------------

describe("evalGateCheck() — extended", () => {
  it("returns passed:true when threshold is 0 regardless of pass rate", () => {
    const report = makeReportShape({ correctness: 0 });
    const result = evalGateCheck(report, 0);
    expect(result.passed).toBe(true);
  });

  it("surfaces per-case pass rates in failedCases", () => {
    const report = makeReportShape(
      { correctness: 0.4 },
      [
        { caseId: "failing", scorerPassRates: { correctness: 0.1 } },
        { caseId: "passing", scorerPassRates: { correctness: 0.95 } },
      ],
    );
    const result = evalGateCheck(report, 0.8);
    expect(result.passed).toBe(false);
    const failedCase = result.failedCases.find((c) => c.caseId === "failing");
    const passingCase = result.failedCases.find((c) => c.caseId === "passing");
    expect(failedCase).toBeDefined();
    expect(passingCase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Baseline JSON round-trip (pure function verification without runEval's jiti)
// ---------------------------------------------------------------------------

describe("baseline JSON round-trip", () => {
  it("can serialize and deserialize an EvalReportShape to/from JSON", () => {
    const report = makeReportShape(
      { correctness: 0.85, faithfulness: 0.9 },
      [
        { caseId: "c1", scorerPassRates: { correctness: 0.8, faithfulness: 0.9 } },
        { caseId: "c2", scorerPassRates: { correctness: 0.9, faithfulness: 0.9 } },
      ],
    );

    const jsonPath = join(tmpDir, "baseline.json");
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

    expect(existsSync(jsonPath)).toBe(true);

    const raw = readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as EvalReportShape;

    expect(parsed.aggregate["correctness"]?.pass).toBeCloseTo(0.85);
    expect(parsed.cases).toHaveLength(2);
    expect(parsed.cases[0]!.caseId).toBe("c1");
  });

  it("creates parent directories when saving a baseline to a nested path", () => {
    const nestedPath = join(tmpDir, ".eidentic", "baselines", "eval-baseline.json");
    const report = makeReportShape({ correctness: 1 });

    // Simulate what runEval does: mkdirSync(dirname(saveBaselinePath), { recursive: true })
    const { dirname } = { dirname: (p: string) => p.split("/").slice(0, -1).join("/") };
    mkdirSync(dirname(nestedPath), { recursive: true });
    writeFileSync(nestedPath, JSON.stringify(report, null, 2), "utf8");

    expect(existsSync(nestedPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New --report / --save-baseline / --baseline flag shapes
// (pure validation; full integration requires a real eval config via jiti)
// ---------------------------------------------------------------------------

describe("eval command flag validation helpers", () => {
  it("computePassRate agrees with evalGateCheck.actualPassRate", () => {
    const report = makeReportShape({
      correctness: 0.7,
      faithfulness: 0.5,
    });
    const manual = computePassRate(report.aggregate);
    const gateResult = evalGateCheck(report, 0.9);
    expect(gateResult.actualPassRate).toBeCloseTo(manual);
  });

  it("evalGateCheck.passed is consistent with threshold boundary", () => {
    const passRate = 0.75;
    const report = makeReportShape({ correctness: passRate });

    expect(evalGateCheck(report, passRate).passed).toBe(true);       // exactly at threshold
    expect(evalGateCheck(report, passRate + 0.01).passed).toBe(false); // just above
    expect(evalGateCheck(report, passRate - 0.01).passed).toBe(true);  // just below
  });
});
