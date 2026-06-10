import { describe, it, expect } from "vitest";
import { assertPassRate, summarize, EvalThresholdError } from "../src/gate.js";
import type { EvalReport } from "../src/evaluate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(
  scorerPassRates: Record<string, number>,
  cases: Array<{ caseId: string; scorerPassRates: Record<string, number> }> = [],
): EvalReport {
  const aggregate: EvalReport["aggregate"] = {};
  for (const [name, pass] of Object.entries(scorerPassRates)) {
    aggregate[name] = { mean: pass, pass, n: 10 };
  }

  const reportCases: EvalReport["cases"] = cases.map((c) => ({
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
// assertPassRate — pass scenarios
// ---------------------------------------------------------------------------

describe("assertPassRate — passes", () => {
  it("does not throw when aggregate pass rate equals threshold (boundary)", () => {
    const report = makeReport({ correctness: 0.8, faithfulness: 0.8 });
    expect(() => assertPassRate(report, 0.8)).not.toThrow();
  });

  it("does not throw when aggregate pass rate exceeds threshold", () => {
    const report = makeReport({ correctness: 1, faithfulness: 1 });
    expect(() => assertPassRate(report, 0.9)).not.toThrow();
  });

  it("does not throw for a single scorer at threshold", () => {
    const report = makeReport({ correctness: 0.5 });
    expect(() => assertPassRate(report, 0.5)).not.toThrow();
  });

  it("does not throw with threshold 0 (always passes)", () => {
    const report = makeReport({ correctness: 0 });
    expect(() => assertPassRate(report, 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertPassRate — fail scenarios
// ---------------------------------------------------------------------------

describe("assertPassRate — fails", () => {
  it("throws EvalThresholdError when aggregate pass rate is below threshold", () => {
    const report = makeReport({ correctness: 0.6 });
    expect(() => assertPassRate(report, 0.8)).toThrowError(EvalThresholdError);
  });

  it("thrown error carries actual and required pass rates", () => {
    const report = makeReport({ correctness: 0.5, faithfulness: 0.5 });
    let err: EvalThresholdError | undefined;
    try {
      assertPassRate(report, 0.9);
    } catch (e) {
      err = e as EvalThresholdError;
    }
    expect(err).toBeDefined();
    expect(err!.actualPassRate).toBeCloseTo(0.5);
    expect(err!.requiredPassRate).toBe(0.9);
  });

  it("error message contains actual and required percentages", () => {
    const report = makeReport({ correctness: 0.6 });
    let msg = "";
    try {
      assertPassRate(report, 0.8);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("60.0%");
    expect(msg).toContain("80.0%");
  });

  it("thrown error includes failing cases with their per-case pass rates", () => {
    const report = makeReport(
      { correctness: 0.5 },
      [
        { caseId: "case-A", scorerPassRates: { correctness: 0.2 } },
        { caseId: "case-B", scorerPassRates: { correctness: 1.0 } },
      ],
    );
    let err: EvalThresholdError | undefined;
    try {
      assertPassRate(report, 0.8);
    } catch (e) {
      err = e as EvalThresholdError;
    }
    expect(err!.failedCases).toHaveLength(1);
    expect(err!.failedCases[0]!.caseId).toBe("case-A");
    expect(err!.failedCases[0]!.passRate).toBeCloseTo(0.2);
  });

  it("has name EvalThresholdError for programmatic detection", () => {
    const report = makeReport({ correctness: 0 });
    try {
      assertPassRate(report, 0.5);
    } catch (e) {
      expect((e as Error).name).toBe("EvalThresholdError");
    }
  });
});

// ---------------------------------------------------------------------------
// assertPassRate — scorer filter (opts.scorers)
// ---------------------------------------------------------------------------

describe("assertPassRate — scorer filter", () => {
  it("only considers specified scorers when opts.scorers is given", () => {
    // correctness=1, faithfulness=0 → aggregate 0.5 if both, 1.0 if only correctness
    const report = makeReport({ correctness: 1, faithfulness: 0 });
    // With both: 0.5 < 0.8 → throws
    expect(() => assertPassRate(report, 0.8)).toThrowError(EvalThresholdError);
    // With only correctness: 1.0 >= 0.8 → passes
    expect(() => assertPassRate(report, 0.8, { scorers: ["correctness"] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertPassRate — edge: no scorers
// ---------------------------------------------------------------------------

describe("assertPassRate — empty report", () => {
  it("treats a report with no scorers as 0% pass rate (fail when threshold > 0)", () => {
    const report: EvalReport = { cases: [], aggregate: {} };
    expect(() => assertPassRate(report, 0.5)).toThrowError(EvalThresholdError);
  });

  it("passes when threshold is 0 even with no scorers", () => {
    const report: EvalReport = { cases: [], aggregate: {} };
    expect(() => assertPassRate(report, 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize()", () => {
  it("returns a non-empty string for a normal report", () => {
    const report = makeReport(
      { correctness: 0.8 },
      [{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }],
    );
    const out = summarize(report);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("includes the scorer name and pass rate in the output", () => {
    const report = makeReport({ correctness: 0.75 });
    const out = summarize(report);
    expect(out).toContain("correctness");
    expect(out).toContain("75.0%");
  });

  it("includes case IDs in the per-case section", () => {
    const report = makeReport(
      { correctness: 1 },
      [
        { caseId: "alpha", scorerPassRates: { correctness: 1 } },
        { caseId: "beta", scorerPassRates: { correctness: 0.5 } },
      ],
    );
    const out = summarize(report);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  it("returns a descriptive message for an empty report", () => {
    const report: EvalReport = { cases: [], aggregate: {} };
    const out = summarize(report);
    expect(out).toContain("no scorers");
  });
});
