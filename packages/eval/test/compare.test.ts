import { describe, it, expect } from "vitest";
import { compareReports } from "../src/compare.js";
import type { EvalReport } from "../src/evaluate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(
  cases: Array<{ caseId: string; scorerPassRates: Record<string, number> }>,
): EvalReport {
  const aggregate: EvalReport["aggregate"] = {};

  // Accumulate aggregate from case scorerMeans
  const scorerTotals: Record<string, { sum: number; n: number }> = {};

  const reportCases: EvalReport["cases"] = cases.map((c) => ({
    caseId: c.caseId,
    input: c.caseId,
    samples: [],
    scorerMeans: Object.fromEntries(
      Object.entries(c.scorerPassRates).map(([name, pass]) => {
        scorerTotals[name] ??= { sum: 0, n: 0 };
        scorerTotals[name]!.sum += pass;
        scorerTotals[name]!.n++;
        return [name, { mean: pass, pass, n: 1 }];
      }),
    ),
  }));

  for (const [name, { sum, n }] of Object.entries(scorerTotals)) {
    aggregate[name] = { mean: sum / n, pass: sum / n, n };
  }

  return { cases: reportCases, aggregate };
}

// ---------------------------------------------------------------------------
// compareReports — regressions
// ---------------------------------------------------------------------------

describe("compareReports — regressions", () => {
  it("detects a regression when current pass rate drops beyond tolerance", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);

    const result = compareReports(baseline, current);

    expect(result.verdict).toBe("regressed");
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]!.caseName).toBe("c1");
    expect(result.regressions[0]!.scorer).toBe("correctness");
    expect(result.regressions[0]!.baseline).toBeCloseTo(0.9);
    expect(result.regressions[0]!.current).toBeCloseTo(0.5);
    expect(result.regressions[0]!.delta).toBeCloseTo(-0.4);
  });

  it("returns verdict:pass when there are no regressions", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);

    const result = compareReports(baseline, current);

    expect(result.verdict).toBe("pass");
    expect(result.regressions).toHaveLength(0);
  });

  it("does not flag a regression within tolerance (default 0.02)", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.79 } }]);

    const result = compareReports(baseline, current, { tolerance: 0.02 });

    expect(result.verdict).toBe("pass");
    expect(result.regressions).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });

  it("flags a regression just beyond tolerance", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.77 } }]);

    const result = compareReports(baseline, current, { tolerance: 0.02 });

    expect(result.verdict).toBe("regressed");
    expect(result.regressions).toHaveLength(1);
  });

  it("detects multiple regressions across cases and scorers", () => {
    const baseline = makeReport([
      { caseId: "c1", scorerPassRates: { correctness: 0.9, faithfulness: 0.8 } },
      { caseId: "c2", scorerPassRates: { correctness: 1.0 } },
    ]);
    const current = makeReport([
      { caseId: "c1", scorerPassRates: { correctness: 0.5, faithfulness: 0.5 } },
      { caseId: "c2", scorerPassRates: { correctness: 0.6 } },
    ]);

    const result = compareReports(baseline, current);

    expect(result.verdict).toBe("regressed");
    expect(result.regressions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// compareReports — improvements
// ---------------------------------------------------------------------------

describe("compareReports — improvements", () => {
  it("classifies an improvement when current exceeds baseline beyond tolerance", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);

    const result = compareReports(baseline, current);

    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0]!.delta).toBeCloseTo(0.4);
    expect(result.verdict).toBe("pass");
  });

  it("does not count an improvement within tolerance as unchanged", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.81 } }]);

    const result = compareReports(baseline, current, { tolerance: 0.02 });

    expect(result.improvements).toHaveLength(0);
    expect(result.unchanged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compareReports — tolerance
// ---------------------------------------------------------------------------

describe("compareReports — configurable tolerance", () => {
  it("uses custom tolerance to suppress small regressions", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.74 } }]);

    // Default tolerance 0.02: delta=-0.06 > 0.02 → regression
    const strictResult = compareReports(baseline, current, { tolerance: 0.02 });
    expect(strictResult.verdict).toBe("regressed");

    // Loose tolerance 0.1: delta=-0.06 < 0.1 → unchanged
    const looseResult = compareReports(baseline, current, { tolerance: 0.1 });
    expect(looseResult.verdict).toBe("pass");
    expect(looseResult.unchanged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// compareReports — missing cases / scorers
// ---------------------------------------------------------------------------

describe("compareReports — missing cases/scorers", () => {
  it("treats a case missing from baseline as 0 baseline pass rate", () => {
    const baseline = makeReport([]);
    const current = makeReport([{ caseId: "new-case", scorerPassRates: { correctness: 0.8 } }]);

    const result = compareReports(baseline, current);

    // 0 → 0.8: improvement
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0]!.baseline).toBe(0);
    expect(result.improvements[0]!.current).toBeCloseTo(0.8);
  });

  it("treats a scorer missing from current as 0 current pass rate", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: {} }]);

    const result = compareReports(baseline, current);

    // 0.9 → 0: regression
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]!.current).toBe(0);
  });

  it("handles both reports being empty", () => {
    const baseline = makeReport([]);
    const current = makeReport([]);

    const result = compareReports(baseline, current);

    expect(result.verdict).toBe("pass");
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
    expect(result.unchanged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// compareReports — unchanged count
// ---------------------------------------------------------------------------

describe("compareReports — unchanged count", () => {
  it("counts unchanged (case, scorer) pairs correctly", () => {
    const baseline = makeReport([
      { caseId: "c1", scorerPassRates: { correctness: 0.8, faithfulness: 0.7 } },
      { caseId: "c2", scorerPassRates: { correctness: 0.9 } },
    ]);
    const current = makeReport([
      { caseId: "c1", scorerPassRates: { correctness: 0.81, faithfulness: 0.69 } },
      { caseId: "c2", scorerPassRates: { correctness: 0.91 } },
    ]);

    // All deltas < 0.02 → all unchanged
    const result = compareReports(baseline, current, { tolerance: 0.02 });

    expect(result.unchanged).toBe(3);
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });
});
