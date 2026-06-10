import type { EvalReport, CaseReport } from "./evaluate.js";

// ---------------------------------------------------------------------------
// EvalThresholdError
// ---------------------------------------------------------------------------

export interface FailedCase {
  caseId: string;
  /** Overall pass rate for this case across all scorers and samples. */
  passRate: number;
  /** Per-scorer pass rates for this case. */
  scorerPassRates: Record<string, number>;
}

/**
 * Thrown by `assertPassRate` when the aggregate pass rate is below the threshold.
 * Carries machine-readable fields so callers can format their own output.
 */
export class EvalThresholdError extends Error {
  /** The observed aggregate pass rate in [0, 1]. */
  readonly actualPassRate: number;
  /** The required threshold in [0, 1]. */
  readonly requiredPassRate: number;
  /** Cases whose aggregate pass rate is below the threshold. */
  readonly failedCases: FailedCase[];

  constructor(actual: number, required: number, failedCases: FailedCase[]) {
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const caseList = failedCases
      .map((c) => `  - ${c.caseId} (${pct(c.passRate)})`)
      .join("\n");
    const msg =
      `Eval pass rate ${pct(actual)} is below the required threshold of ${pct(required)}.\n` +
      (failedCases.length > 0
        ? `Failing cases (${failedCases.length}):\n${caseList}`
        : "No individual cases identified.");
    super(msg);
    this.name = "EvalThresholdError";
    this.actualPassRate = actual;
    this.requiredPassRate = required;
    this.failedCases = failedCases;
  }
}

// ---------------------------------------------------------------------------
// assertPassRate
// ---------------------------------------------------------------------------

export interface AssertPassRateOptions {
  /**
   * Only consider these scorer names when computing the aggregate pass rate.
   * Default: all scorers in the report.
   */
  scorers?: string[];
}

/**
 * Assert that the aggregate pass rate in `report` meets `threshold` (0–1, e.g. 0.8 = 80 %).
 *
 * Throws `EvalThresholdError` with the actual vs. required pass rate and a list of failing cases
 * when the aggregate is below the threshold. Returns cleanly otherwise.
 *
 * The aggregate pass rate is computed as the mean of the per-scorer `pass` rates in
 * `report.aggregate` (already fraction-of-samples that passed per scorer). If the report has no
 * scorers, the pass rate is treated as 0.
 *
 * @param report    - The `EvalReport` returned by `evaluate()`.
 * @param threshold - Required pass rate in [0, 1].
 * @param opts      - Optional: restrict to a subset of scorers.
 */
export function assertPassRate(
  report: EvalReport,
  threshold: number,
  opts?: AssertPassRateOptions,
): void {
  const entries = Object.entries(report.aggregate).filter(
    ([name]) => !opts?.scorers || opts.scorers.includes(name),
  );

  // Aggregate pass rate: mean of each scorer's pass fraction.
  const aggregatePassRate =
    entries.length === 0
      ? 0
      : entries.reduce((sum, [, e]) => sum + e.pass, 0) / entries.length;

  if (aggregatePassRate >= threshold) return;

  // Identify failing cases: those whose mean pass rate (across all requested scorers) is below threshold.
  const failedCases: FailedCase[] = report.cases
    .map((c: CaseReport): FailedCase => {
      const relevant = Object.entries(c.scorerMeans).filter(
        ([name]) => !opts?.scorers || opts.scorers.includes(name),
      );
      const casePassRate =
        relevant.length === 0
          ? 0
          : relevant.reduce((sum, [, e]) => sum + e.pass, 0) / relevant.length;
      const scorerPassRates = Object.fromEntries(
        relevant.map(([name, e]) => [name, e.pass]),
      );
      return { caseId: c.caseId, passRate: casePassRate, scorerPassRates };
    })
    .filter((c) => c.passRate < threshold);

  throw new EvalThresholdError(aggregatePassRate, threshold, failedCases);
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

/**
 * Produce a human-readable, CI-friendly summary of an `EvalReport`.
 * Does not call `assertPassRate` — the caller decides whether to gate.
 */
export function summarize(report: EvalReport): string {
  const lines: string[] = [];

  const scorerNames = Object.keys(report.aggregate);
  if (scorerNames.length === 0) {
    return "EvalReport: no scorers — nothing to summarize.";
  }

  // Overall aggregate
  lines.push("=== Eval Summary ===");
  lines.push(`Cases: ${report.cases.length}`);
  lines.push("");
  lines.push("Aggregate (across all cases × samples):");
  for (const name of scorerNames) {
    const e = report.aggregate[name]!;
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    lines.push(`  ${name}: pass=${pct(e.pass)}  mean=${pct(e.mean)}  n=${e.n}`);
  }

  // Per-case breakdown
  lines.push("");
  lines.push("Per-case:");
  for (const c of report.cases) {
    const scorerSummary = Object.entries(c.scorerMeans)
      .map(([name, e]) => `${name}=${(e.pass * 100).toFixed(0)}%`)
      .join("  ");
    lines.push(`  [${c.caseId}] ${scorerSummary}`);

    // Surface per-sample runner errors
    for (const s of c.samples) {
      if (s.runnerError) {
        lines.push(`    sample ${s.sampleIndex}: runner error — ${s.runnerError}`);
      }
    }
  }

  return lines.join("\n");
}
