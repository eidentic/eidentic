import type { EvalReport } from "./evaluate.js";
import type { CompareResult } from "./compare.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RenderReportMarkdownOptions {
  /** When provided, inline regression/improvement annotations into the table. */
  compare?: CompareResult;
  /**
   * Title rendered as a level-2 heading.
   * Default: "Eval Report"
   */
  title?: string;
}

// ---------------------------------------------------------------------------
// renderReportMarkdown
// ---------------------------------------------------------------------------

/**
 * Render an `EvalReport` as a GitHub-comment-friendly Markdown document.
 *
 * The output includes:
 * - An aggregate summary table (one row per scorer).
 * - A per-case table (one row per case, columns per scorer).
 * - When `opts.compare` is supplied: a regression/improvement summary section
 *   with highlighted deltas so a PR reviewer can see what changed at a glance.
 *
 * The document starts with an HTML comment marker used by the GitHub Actions
 * workflow to locate and update the comment idempotently.
 *
 * @param report - The `EvalReport` returned by `evaluate()`.
 * @param opts   - Optional configuration (compare, title).
 */
export function renderReportMarkdown(
  report: EvalReport,
  opts: RenderReportMarkdownOptions = {},
): string {
  const title = opts.title ?? "Eval Report";
  const scorerNames = Object.keys(report.aggregate);
  const lines: string[] = [];

  // Idempotent marker — the GitHub Actions workflow searches for this.
  lines.push("<!-- eidentic-eval-report -->");
  lines.push("");
  lines.push(`## ${title}`);
  lines.push("");

  // ── Aggregate summary ───────────────────────────────────────────────────────
  if (scorerNames.length === 0) {
    lines.push("_No scorers in this report._");
    return lines.join("\n");
  }

  lines.push("### Aggregate");
  lines.push("");
  lines.push("| Scorer | Pass rate | Mean score | N |");
  lines.push("| ------ | --------- | ---------- | - |");
  for (const name of scorerNames) {
    const e = report.aggregate[name]!;
    lines.push(`| ${name} | ${pct(e.pass)} | ${pct(e.mean)} | ${e.n} |`);
  }
  lines.push("");

  // ── Per-case breakdown ──────────────────────────────────────────────────────
  lines.push("### Per-case");
  lines.push("");

  const headerCells = ["| Case", ...scorerNames.map((n) => ` ${n}`), " |"].join(" |");
  const separatorCells = ["| ----", ...scorerNames.map(() => " ----"), " |"].join(" |");
  lines.push(headerCells);
  lines.push(separatorCells);

  for (const c of report.cases) {
    // Build regression/improvement lookup for this case if compare is provided.
    const compareAnnotations = buildAnnotations(c.caseId, opts.compare);

    const cells: string[] = [`| ${c.caseId}`];
    for (const scorer of scorerNames) {
      const entry = c.scorerMeans[scorer];
      const passRate = entry ? pct(entry.pass) : "—";
      const annotation = compareAnnotations[scorer];
      cells.push(` ${passRate}${annotation ? ` ${annotation}` : ""}`);
    }
    cells.push(" |");
    lines.push(cells.join(" |"));
  }
  lines.push("");

  // ── Regression / improvement summary (only when compare is provided) ────────
  if (opts.compare) {
    const { regressions, improvements, verdict } = opts.compare;

    const verdictEmoji = verdict === "pass" ? "✅" : "❌";
    lines.push(`### Comparison verdict: ${verdictEmoji} ${verdict === "pass" ? "No regressions" : `${regressions.length} regression(s) detected`}`);
    lines.push("");

    if (regressions.length > 0) {
      lines.push("**Regressions**");
      lines.push("");
      lines.push("| Case | Scorer | Baseline | Current | Delta |");
      lines.push("| ---- | ------ | -------- | ------- | ----- |");
      for (const r of regressions) {
        lines.push(`| ${r.caseName} | ${r.scorer} | ${pct(r.baseline)} | ${pct(r.current)} | **${signedPct(r.delta)}** |`);
      }
      lines.push("");
    }

    if (improvements.length > 0) {
      lines.push("**Improvements**");
      lines.push("");
      lines.push("| Case | Scorer | Baseline | Current | Delta |");
      lines.push("| ---- | ------ | -------- | ------- | ----- |");
      for (const i of improvements) {
        lines.push(`| ${i.caseName} | ${i.scorer} | ${pct(i.baseline)} | ${pct(i.current)} | ${signedPct(i.delta)} |`);
      }
      lines.push("");
    }

    if (regressions.length === 0 && improvements.length === 0) {
      lines.push("_All scores within tolerance — no changes detected._");
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number): string {
  const formatted = `${(Math.abs(n) * 100).toFixed(1)}%`;
  return n >= 0 ? `+${formatted}` : `-${formatted}`;
}

/**
 * Build a map of scorer → annotation string for a given case.
 * Returns empty object when no compare result is provided.
 */
function buildAnnotations(
  caseId: string,
  compare: CompareResult | undefined,
): Record<string, string> {
  if (!compare) return {};
  const annotations: Record<string, string> = {};
  for (const r of compare.regressions) {
    if (r.caseName === caseId) {
      annotations[r.scorer] = `(**${signedPct(r.delta)}**)`;
    }
  }
  for (const i of compare.improvements) {
    if (i.caseName === caseId) {
      annotations[i.scorer] = `(${signedPct(i.delta)})`;
    }
  }
  return annotations;
}
