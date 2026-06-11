/**
 * Markdown results renderer for LongMemEval benchmark reports.
 *
 * Produces a defensible, methodology-transparent table suitable for publication.
 * Per the mandatory fair-run rules, results MUST include:
 *   - Model ids and judge model id
 *   - topK value (memory mode)
 *   - Dataset provenance (source URL + snapshot sha)
 *   - Mode (memory | full-context)
 *   - Seed and n-questions
 *   - Per-type accuracy breakdown
 *   - Abstention accuracy reported separately
 */

import type { LmeReport } from "./lme-run.js";

/** Optional price table for cost estimates (per 1M tokens, input/output). */
export interface LmePriceTable {
  /** Per-million input tokens in USD. */
  inputPer1M: number;
  /** Per-million output tokens in USD. */
  outputPer1M: number;
}

const QUESTION_TYPE_LABELS: Record<string, string> = {
  "single-session-user": "Single-session (user)",
  "single-session-assistant": "Single-session (asst.)",
  "single-session-preference": "Single-session (pref.)",
  "multi-session": "Multi-session",
  "temporal-reasoning": "Temporal reasoning",
  "knowledge-update": "Knowledge update",
};

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function estimateCost(
  tokens: { totalInputTokens: number; totalOutputTokens: number },
  prices?: LmePriceTable,
): string {
  if (!prices) return "—";
  const cost =
    (tokens.totalInputTokens / 1_000_000) * prices.inputPer1M +
    (tokens.totalOutputTokens / 1_000_000) * prices.outputPer1M;
  return `$${cost.toFixed(4)}`;
}

function fmtStat(s: { correct: number; total: number; accuracy: number } | undefined): string {
  if (!s || s.total === 0) return "—";
  return `${pct(s.accuracy)} (${s.correct}/${s.total})`;
}

/**
 * Render one or more LongMemEval benchmark reports as a Markdown table
 * with mandatory methodology notes.
 *
 * @param reports  - Array of LmeReport objects to compare.
 * @param prices   - Optional price table for cost-per-run estimates (per 1M tokens).
 * @returns        - Markdown string ready to write to a .md file.
 */
export function renderLongMemEvalReportMarkdown(
  reports: LmeReport[],
  prices?: LmePriceTable,
): string {
  const lines: string[] = [];

  lines.push("# LongMemEval Benchmark Results");
  lines.push("");
  lines.push(
    "Dataset: [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al.) · MIT License",
  );
  lines.push("Raw data is not redistributed. Only aggregate results are published here.");
  lines.push("");

  if (reports.length === 0) {
    lines.push("_No results yet._");
    return lines.join("\n");
  }

  // Collect all base types seen across all reports
  const allBaseTypes = new Set<string>();
  for (const r of reports) {
    for (const t of Object.keys(r.byType)) allBaseTypes.add(t);
  }
  const sortedTypes = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
  ].filter((t) => allBaseTypes.has(t));
  // Append any unknown types in alphabetical order
  for (const t of [...allBaseTypes].sort()) {
    if (!sortedTypes.includes(t)) sortedTypes.push(t);
  }

  // Main results table
  const typeHeaders = sortedTypes.map(
    (t) => QUESTION_TYPE_LABELS[t] ?? t,
  );

  const headers = [
    "System / Mode",
    ...typeHeaders,
    "Overall accuracy",
    "Abstention accuracy",
    "Tokens/query",
    "Est. cost/run",
    "Answer model",
    "Judge model",
    "topK",
    "n-Q",
    "Seed",
    "Dataset provenance",
  ];

  lines.push("## Results");
  lines.push("");
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");

  for (const r of reports) {
    const c = r.config;
    const typeRow = sortedTypes.map((t) => fmtStat(r.byType[t]));

    const totalQ = r.questions.length;
    const tokensPerQuery =
      totalQ > 0
        ? Math.round(
            (r.tokens.totalInputTokens + r.tokens.totalOutputTokens) / totalQ,
          )
        : 0;

    const provenance = `${c.datasetSource.url.replace("https://", "")} @ ${c.datasetSource.snapshotSha.slice(0, 8)}`;

    const row = [
      `${c.answerModelId} / ${c.mode}`,
      ...typeRow,
      fmtStat(r.overall),
      fmtStat(r.abstentionAccuracy),
      fmtNum(tokensPerQuery),
      estimateCost(r.tokens, prices),
      c.answerModelId,
      c.judgeModelId,
      c.mode === "memory" ? String(c.topK) : "—",
      fmtNum(r.config.questionsRun),
      String(c.seed),
      provenance,
    ];

    lines.push("| " + row.join(" | ") + " |");
  }

  lines.push("");

  // Per-run config disclosure
  lines.push("## Run Configuration");
  lines.push("");
  for (const r of reports) {
    const c = r.config;
    lines.push(`### ${c.answerModelId} / ${c.mode}`);
    lines.push("");
    lines.push(`- **Mode**: ${c.mode}`);
    lines.push(`- **Answer model**: ${c.answerModelId}`);
    lines.push(`- **Judge model**: ${c.judgeModelId}`);
    if (c.mode === "memory") lines.push(`- **topK**: ${c.topK}`);
    lines.push(`- **Dataset source**: ${c.datasetSource.url}`);
    lines.push(`- **Dataset snapshot SHA**: \`${c.datasetSource.snapshotSha}\``);
    lines.push(`- **Dataset file**: ${c.datasetSource.file}`);
    lines.push(`- **Dataset license**: ${c.datasetSource.license}`);
    lines.push(`- **Seed**: ${c.seed}`);
    lines.push(`- **Types**: ${c.types.join(", ") || "all"}`);
    lines.push(`- **Questions run**: ${c.questionsRun}`);
    lines.push(`- **Wall-clock**: ${(r.wallClockMs / 1000).toFixed(1)}s`);
    lines.push(`- **Errors**: ${r.errorCount}`);
    lines.push(
      `- **Tokens** (in/out): ${fmtNum(r.tokens.totalInputTokens)} / ${fmtNum(r.tokens.totalOutputTokens)}`,
    );
    lines.push("");
  }

  // Mandatory methodology notes
  lines.push("## Methodology Notes");
  lines.push("");
  lines.push(
    "These results were produced using the Eidentic LongMemEval fair-run harness. " +
    "The following rules apply:",
  );
  lines.push("");
  lines.push(
    "1. **Per-question memory scope.** Each question has its own haystack (~50 sessions on average). " +
    "A fresh Memory instance is created per question; no cross-question contamination.",
  );
  lines.push(
    "2. **Dual-granularity ingest.** Each turn is ingested with its session date in the text " +
    "(temporally anchored). An additional session-level chunk entry captures multi-turn context.",
  );
  lines.push(
    "3. **Current date in prompt.** The `question_date` is passed to the answer prompt " +
    "so temporal questions can reason about recency.",
  );
  lines.push(
    "4. **topK ≤ 10 in memory mode.** Larger topK values trivialise retrieval quality and are not permitted.",
  );
  lines.push(
    "5. **Full-context baseline is required** alongside any memory-mode result.",
  );
  lines.push(
    "6. **Judge is strict**: a model answer is correct only when it contains the gold answer's " +
    "specific information. Vague/topical-only answers are wrong. Equivalent date expressions for " +
    "the same date/duration are correct (temporal-reasoning type).",
  );
  lines.push(
    "7. **Abstention questions** (not present in longmemeval_s.json standard split): correct = model " +
    "declined / said no-info / identified a flawed premise; fabricating a specific answer = wrong. " +
    "Abstention accuracy is reported separately and not folded into overall accuracy.",
  );
  lines.push(
    "8. **Dataset license**: MIT — raw data is not redistributed; only aggregate results are published.",
  );
  lines.push("");
  lines.push("> Per-type question counts in longmemeval_s.json (500 total):");
  lines.push("> single-session-user 70, single-session-assistant 56, single-session-preference 30,");
  lines.push("> multi-session 133, temporal-reasoning 133, knowledge-update 78.");
  lines.push("> No abstention variants in the standard _s split.");
  lines.push("");

  return lines.join("\n");
}
