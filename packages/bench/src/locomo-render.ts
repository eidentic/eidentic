/**
 * Markdown results renderer for LoCoMo benchmark reports.
 *
 * Produces a defensible, methodology-transparent table suitable for publication.
 * Per the mandatory fair-run rules, results MUST include:
 *   - Model ids and judge model id
 *   - topK value
 *   - Dataset SHA (provenance)
 *   - Mode (memory | full-context)
 *   - Seed and n-questions
 */

import type { LocomoReport } from "./locomo-run.js";

/** Optional price table for cost estimates (per 1M tokens, input/output). */
export interface PriceTable {
  /** Per-million input tokens in USD. */
  inputPer1M: number;
  /** Per-million output tokens in USD. */
  outputPer1M: number;
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function estimateCost(tokens: { totalInputTokens: number; totalOutputTokens: number }, prices?: PriceTable): string {
  if (!prices) return "—";
  const cost =
    (tokens.totalInputTokens / 1_000_000) * prices.inputPer1M +
    (tokens.totalOutputTokens / 1_000_000) * prices.outputPer1M;
  return `$${cost.toFixed(4)}`;
}

/**
 * Render one or more LoCoMo benchmark reports as a Markdown table with mandatory methodology notes.
 *
 * @param reports  - Array of LocomoReport objects to compare.
 * @param prices   - Optional price table for cost-per-run estimates (per 1M tokens).
 * @returns        - Markdown string ready to write to a .md file.
 */
export function renderLocomoReportMarkdown(
  reports: LocomoReport[],
  prices?: PriceTable,
): string {
  const lines: string[] = [];

  lines.push("# LoCoMo Benchmark Results");
  lines.push("");
  lines.push("Dataset: [LoCoMo](https://github.com/snap-research/locomo) (Snap Research) · CC BY-NC 4.0");
  lines.push("Raw data is not redistributed. Only aggregate results are published here.");
  lines.push("");

  if (reports.length === 0) {
    lines.push("_No results yet._");
    return lines.join("\n");
  }

  // Main results table
  const headers = [
    "System / Mode",
    "Cat1 (multi-hop)",
    "Cat2 (temporal)",
    "Cat3 (open-domain)",
    "Cat4 (single-hop)",
    "J(1–4) overall",
    "Cat5 refusal rate",
    "Tokens/query",
    "Est. cost/run",
    "Answer model",
    "Judge model",
    "topK",
    "n-Q",
    "Seed",
    "Dataset SHA",
  ];

  lines.push("## Results");
  lines.push("");
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");

  for (const r of reports) {
    const c = r.config;
    const cat = (n: number) => {
      const s = r.byCategory[String(n)];
      if (!s) return "—";
      return `${pct(s.accuracy)} (${s.correct}/${s.total})`;
    };
    const cat5 = r.cat5RefusalRate
      ? `${pct(r.cat5RefusalRate.rate)} (${r.cat5RefusalRate.correct}/${r.cat5RefusalRate.total})`
      : "—";

    const totalQ = r.questions.length;
    const tokensPerQuery = totalQ > 0
      ? Math.round((r.tokens.totalInputTokens + r.tokens.totalOutputTokens) / totalQ)
      : 0;

    const row = [
      `${c.answerModelId} / ${c.mode}`,
      cat(1),
      cat(2),
      cat(3),
      cat(4),
      `${pct(r.overallJ14.accuracy)} (${r.overallJ14.correct}/${r.overallJ14.total})`,
      cat5,
      fmtNum(tokensPerQuery),
      estimateCost(r.tokens, prices),
      c.answerModelId,
      c.judgeModelId,
      String(c.topK),
      fmtNum(r.config.questionsRun),
      String(c.seed),
      c.datasetSha.slice(0, 8),
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
    lines.push(`- **topK**: ${c.topK}`);
    lines.push(`- **Dataset SHA**: \`${c.datasetSha}\``);
    lines.push(`- **Seed**: ${c.seed}`);
    lines.push(`- **Categories**: ${c.categories.join(", ")}`);
    lines.push(`- **Samples run**: ${c.samplesRun}`);
    lines.push(`- **Questions run**: ${c.questionsRun}`);
    lines.push(`- **Wall-clock**: ${(r.wallClockMs / 1000).toFixed(1)}s`);
    lines.push(`- **Errors**: ${r.errorCount}`);
    lines.push(`- **Tokens** (in/out): ${fmtNum(r.tokens.totalInputTokens)} / ${fmtNum(r.tokens.totalOutputTokens)}`);
    lines.push("");
  }

  // Mandatory notes
  lines.push("## Methodology Notes");
  lines.push("");
  lines.push("These results were produced using the Eidentic LoCoMo fair-run harness. The following rules apply:");
  lines.push("");
  lines.push("1. **Both speakers are treated as humans.** Turns are ingested as `[SpeakerName]: text` — never mapped to user/assistant roles.");
  lines.push("2. **Timestamps are structural.** Each session is prefixed with a header line `Session N — <date>` and `ingestedAt` metadata carries the epoch-ms.");
  lines.push("3. **topK ≤ 10 in memory mode.** Larger topK values trivialise retrieval quality and are not permitted.");
  lines.push("4. **Full-context baseline is required** alongside any memory-mode result.");
  lines.push("5. **Judge is strict**: a model answer is correct only when it contains the gold answer's specific information. Vague/topical-only answers are wrong.");
  lines.push("6. **Category 5 (adversarial)**: correct = model declined; adversarial-trap match = wrong.");
  lines.push("7. **Primary metric J(1–4)**: denominator is the number of cat 1–4 questions actually run (max 1540 on full dataset).");
  lines.push("8. **Dataset license**: CC BY-NC 4.0 — raw data is not redistributed; only aggregate results are published.");
  lines.push("");
  lines.push("> Category mapping in locomo10.json: 1=multi-hop (282), 2=temporal (321), 3=open-domain (96), 4=single-hop (841), 5=adversarial (446).");
  lines.push("");

  return lines.join("\n");
}
