import { describe, it, expect } from "vitest";
import { renderReportMarkdown } from "../src/markdown.js";
import { compareReports } from "../src/compare.js";
import type { EvalReport } from "../src/evaluate.js";
import type { CompareResult } from "../src/compare.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(
  cases: Array<{ caseId: string; scorerPassRates: Record<string, number> }>,
): EvalReport {
  const aggregate: EvalReport["aggregate"] = {};
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
// Basic structure
// ---------------------------------------------------------------------------

describe("renderReportMarkdown — structure", () => {
  it("includes the idempotent marker comment", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("<!-- eidentic-eval-report -->");
  });

  it("includes the default title heading", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("## Eval Report");
  });

  it("renders a custom title when provided", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 1.0 } }]);
    const md = renderReportMarkdown(report, { title: "My Custom Eval" });
    expect(md).toContain("## My Custom Eval");
  });

  it("returns a graceful message for a report with no scorers", () => {
    const report: EvalReport = { cases: [], aggregate: {} };
    const md = renderReportMarkdown(report);
    expect(md).toContain("No scorers");
  });
});

// ---------------------------------------------------------------------------
// Aggregate table
// ---------------------------------------------------------------------------

describe("renderReportMarkdown — aggregate table", () => {
  it("includes the scorer name and pass rate in the aggregate table", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.75 } }]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("correctness");
    expect(md).toContain("75.0%");
  });

  it("includes multiple scorers in the aggregate table", () => {
    const report = makeReport([
      { caseId: "c1", scorerPassRates: { correctness: 1.0, faithfulness: 0.5 } },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("correctness");
    expect(md).toContain("faithfulness");
  });
});

// ---------------------------------------------------------------------------
// Per-case table
// ---------------------------------------------------------------------------

describe("renderReportMarkdown — per-case table", () => {
  it("includes case IDs in the per-case table", () => {
    const report = makeReport([
      { caseId: "alpha", scorerPassRates: { correctness: 0.8 } },
      { caseId: "beta", scorerPassRates: { correctness: 0.6 } },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
  });

  it("renders table header with scorer column names", () => {
    const report = makeReport([
      { caseId: "c1", scorerPassRates: { toolCorrectness: 0.9, verifierStall: 1.0 } },
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("toolCorrectness");
    expect(md).toContain("verifierStall");
  });
});

// ---------------------------------------------------------------------------
// Comparison section
// ---------------------------------------------------------------------------

describe("renderReportMarkdown — comparison section", () => {
  it("includes comparison section when compare is provided", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    expect(md).toContain("Comparison verdict");
    expect(md).toContain("regression(s) detected");
  });

  it("shows green verdict when no regressions", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.85 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    expect(compare.verdict).toBe("pass");
    expect(md).toContain("No regressions");
  });

  it("renders regression table with baseline/current/delta columns", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    expect(md).toContain("Regressions");
    expect(md).toContain("Baseline");
    expect(md).toContain("Current");
    expect(md).toContain("Delta");
    // The negative delta should be bolded to highlight the regression
    expect(md).toContain("**-40.0%**");
  });

  it("renders improvements section when present", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    expect(md).toContain("Improvements");
    expect(md).toContain("+40.0%");
  });

  it("annotates per-case cells with delta when regressions exist", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.9 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.5 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    // The per-case row for c1 should contain a bolded negative delta annotation
    expect(md).toContain("c1");
    expect(md).toContain("(**-40.0%**)");
  });

  it("renders 'no changes' message when all within tolerance", () => {
    const baseline = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const current = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const compare = compareReports(baseline, current);

    const md = renderReportMarkdown(current, { compare });

    expect(md).toContain("within tolerance");
  });
});

// ---------------------------------------------------------------------------
// Output is valid Markdown-ish
// ---------------------------------------------------------------------------

describe("renderReportMarkdown — output is renderable", () => {
  it("returns a non-empty string", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const md = renderReportMarkdown(report);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });

  it("contains markdown table pipes", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("|");
  });

  it("contains heading markers", () => {
    const report = makeReport([{ caseId: "c1", scorerPassRates: { correctness: 0.8 } }]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("##");
    expect(md).toContain("###");
  });
});
