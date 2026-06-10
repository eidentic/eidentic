import type { EvalReport } from "./evaluate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegressionEntry {
  caseName: string;
  scorer: string;
  /** Pass rate in the baseline report (0–1). */
  baseline: number;
  /** Pass rate in the current report (0–1). */
  current: number;
  /** current - baseline (negative = regression). */
  delta: number;
}

export interface ImprovementEntry {
  caseName: string;
  scorer: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface CompareResult {
  regressions: RegressionEntry[];
  improvements: ImprovementEntry[];
  /** Number of (case, scorer) pairs that changed by less than `tolerance`. */
  unchanged: number;
  /** "pass" when there are no regressions; "regressed" otherwise. */
  verdict: "pass" | "regressed";
}

export interface CompareOptions {
  /**
   * Minimum absolute delta required to count as a regression or improvement.
   * A change smaller than this (in either direction) is counted as "unchanged".
   * Default: 0.02 (2 percentage points).
   */
  tolerance?: number;
}

// ---------------------------------------------------------------------------
// compareReports
// ---------------------------------------------------------------------------

/**
 * Compare a baseline `EvalReport` with a current one and categorize each
 * (case, scorer) pair as a regression, improvement, or unchanged.
 *
 * The verdict is "regressed" when any (case, scorer) pair regresses beyond
 * the tolerance threshold.
 *
 * @param baseline - The reference report (e.g. from a previous CI run).
 * @param current  - The freshly-produced report to compare against the baseline.
 * @param opts     - Optional configuration (tolerance).
 */
export function compareReports(
  baseline: EvalReport,
  current: EvalReport,
  opts: CompareOptions = {},
): CompareResult {
  const tolerance = opts.tolerance ?? 0.02;

  const regressions: RegressionEntry[] = [];
  const improvements: ImprovementEntry[] = [];
  let unchanged = 0;

  // Build a lookup map: caseId → scorer → pass rate, for both reports.
  const baselineMap = buildCaseMap(baseline);
  const currentMap = buildCaseMap(current);

  // Union of all case IDs across both reports.
  const allCaseIds = new Set([...Object.keys(baselineMap), ...Object.keys(currentMap)]);

  for (const caseId of allCaseIds) {
    const baselineScorers = baselineMap[caseId] ?? {};
    const currentScorers = currentMap[caseId] ?? {};

    // Union of all scorer names for this case.
    const allScorers = new Set([...Object.keys(baselineScorers), ...Object.keys(currentScorers)]);

    for (const scorer of allScorers) {
      // Treat a scorer absent from one side as 0 (pessimistic).
      const baselinePass = baselineScorers[scorer] ?? 0;
      const currentPass = currentScorers[scorer] ?? 0;
      const delta = currentPass - baselinePass;

      if (delta < -tolerance) {
        regressions.push({ caseName: caseId, scorer, baseline: baselinePass, current: currentPass, delta });
      } else if (delta > tolerance) {
        improvements.push({ caseName: caseId, scorer, baseline: baselinePass, current: currentPass, delta });
      } else {
        unchanged++;
      }
    }
  }

  return {
    regressions,
    improvements,
    unchanged,
    verdict: regressions.length === 0 ? "pass" : "regressed",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a map of caseId → scorer → per-case pass rate from an EvalReport. */
function buildCaseMap(report: EvalReport): Record<string, Record<string, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const c of report.cases) {
    map[c.caseId] = {};
    for (const [scorer, entry] of Object.entries(c.scorerMeans)) {
      map[c.caseId]![scorer] = entry.pass;
    }
  }
  return map;
}
