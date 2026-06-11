/**
 * LongMemEval benchmark runner — real LLM pilot.
 *
 * Runs the LongMemEval fair-run benchmark harness against the downloaded dataset.
 * Requires data/longmemeval_s.json at the project root (gitignored; MIT license).
 *
 * Usage:
 *   OPENAI_API_KEY=... tsx examples/bench-longmemeval.ts [flags]
 *
 * Flags:
 *   --mode memory|full-context   (default: full-context)
 *   --questions N                cap on total questions (for quick pilot runs)
 *   --types t1,t2,...            comma-separated question types to include (default: all)
 *   --concurrency N              parallel questions in flight (default: 1)
 *   --out report.json            write the full JSON report
 *   --md report.md               write a Markdown results table
 *   --topk N                     snippets retrieved per question in memory mode (max 10)
 *   --seed N                     PRNG seed for reproducibility (default: 42)
 *   --checkpoint path.jsonl      resume an interrupted run from this checkpoint file
 *
 * The script always prints the Markdown table to stdout at the end.
 *
 * To use a different model, replace the `openai(...)` calls below with any
 * AI SDK-compatible provider wrapped in AIModel.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openai } from "@ai-sdk/openai";
import { AIModel, AIEmbedder } from "@eidentic/model";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore } from "@eidentic/types/testing";
import {
  loadLongMemEval,
  runLongMemEvalBench,
  renderLongMemEvalReportMarkdown,
} from "@eidentic/bench";

// ── CLI flag parsing ───────────────────────────────────────────────────────────

function flagStr(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

function flagNum(flag: string, def: number): number {
  const v = flagStr(flag, String(def));
  const n = parseInt(v);
  return Number.isNaN(n) ? def : n;
}

const mode = flagStr("--mode", "full-context") as "memory" | "full-context";
const questionLimit = process.argv.includes("--questions")
  ? flagNum("--questions", 0) || undefined
  : undefined;
const typesArg = flagStr("--types", "");
const types =
  typesArg ? typesArg.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
const concurrency = flagNum("--concurrency", 1);
const outPath = process.argv.includes("--out") ? flagStr("--out", "lme-report.json") : undefined;
const mdPath = process.argv.includes("--md") ? flagStr("--md", "lme-report.md") : undefined;
const topK = Math.min(flagNum("--topk", 10), 10);
const seed = flagNum("--seed", 42);
const checkpointPath = process.argv.includes("--checkpoint")
  ? flagStr("--checkpoint", "lme-checkpoint.jsonl")
  : undefined;

// ── Setup ──────────────────────────────────────────────────────────────────────

const DATA_PATH = resolve(process.cwd(), "data/longmemeval_s.json");

if (!existsSync(DATA_PATH)) {
  console.error(
    `Error: data/longmemeval_s.json not found at ${DATA_PATH}\n\n` +
    "Download the dataset first:\n\n" +
    "  pip install huggingface_hub\n" +
    "  python3 -c \"\n" +
    "    from huggingface_hub import hf_hub_download, list_repo_tree\n" +
    "    # inspect available files:\n" +
    "    for f in list_repo_tree('xiaowu0162/longmemeval', repo_type='dataset'):\n" +
    "        print(f.path)\n" +
    "    path = hf_hub_download(repo_id='xiaowu0162/longmemeval',\n" +
    "        filename='longmemeval_s', repo_type='dataset')\n" +
    "    print('Downloaded to:', path)\n" +
    "  \"\n" +
    "  mkdir -p data && cp <downloaded_path> data/longmemeval_s.json\n",
  );
  process.exit(1);
}

if (!process.env["OPENAI_API_KEY"]) {
  console.error(
    "Error: OPENAI_API_KEY is required.\n" +
    "Set the env var and re-run:\n" +
    "  OPENAI_API_KEY=... tsx examples/bench-longmemeval.ts",
  );
  process.exit(1);
}

console.log("=== LongMemEval Benchmark Pilot ===\n");
console.log(`  Mode:        ${mode}`);
console.log(`  Questions:   ${questionLimit ?? "all"}`);
console.log(`  Types:       ${types ? types.join(", ") : "all"}`);
console.log(`  topK:        ${topK} (memory mode)`);
console.log(`  Concurrency: ${concurrency}`);
console.log(`  Seed:        ${seed}`);
if (checkpointPath) console.log(`  Checkpoint:  ${checkpointPath}`);
console.log();

// ── Models ─────────────────────────────────────────────────────────────────────

const answerModel = new AIModel(
  openai(process.env["EIDENTIC_BENCH_ANSWER_MODEL"] ?? "gpt-4o-mini"),
);
answerModel.modelId =
  process.env["EIDENTIC_BENCH_ANSWER_MODEL"] ?? "gpt-4o-mini";

const judgeModel = new AIModel(
  openai(process.env["EIDENTIC_BENCH_JUDGE_MODEL"] ?? "gpt-4o-mini"),
);
judgeModel.modelId =
  process.env["EIDENTIC_BENCH_JUDGE_MODEL"] ?? "gpt-4o-mini";

// ── Memory factory (used only when mode="memory") ─────────────────────────────

const localEmbedder = await AIEmbedder.create(
  openai.embedding("text-embedding-3-small"),
);

function memoryFactory(): Memory {
  return new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: localEmbedder,
  });
}

// ── Load dataset ──────────────────────────────────────────────────────────────

console.log("Loading dataset ...");
const dataset = await loadLongMemEval(DATA_PATH);
const filtered = types
  ? dataset.questions.filter(
      (q) => types.includes(q.type) || types.includes(q.baseType),
    )
  : dataset.questions;
console.log(
  `  Loaded ${dataset.questions.length} questions` +
  (types ? ` (${filtered.length} after type filter)` : "") +
  "\n",
);

// Print type distribution
const typeCount: Record<string, number> = {};
for (const q of filtered) {
  typeCount[q.type] = (typeCount[q.type] ?? 0) + 1;
}
for (const [t, n] of Object.entries(typeCount).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${t.padEnd(30)} ${n}`);
}
console.log();

// ── Run ────────────────────────────────────────────────────────────────────────

let doneCount = 0;
const totalQ = Math.min(filtered.length, questionLimit ?? filtered.length);

const report = await runLongMemEvalBench({
  dataPath: DATA_PATH,
  dataset,
  answerModel,
  judgeModel,
  mode,
  types,
  questionLimit,
  seed,
  topK,
  concurrency,
  checkpointPath,
  memoryFactory: mode === "memory" ? memoryFactory : undefined,
  onProgress: (done, total) => {
    doneCount = done;
    process.stdout.write(`\r  Progress: ${done}/${total} questions`);
  },
});

console.log(`\r  Progress: ${doneCount}/${totalQ} questions — done!\n`);

// ── Print results ──────────────────────────────────────────────────────────────

console.log("=== Results ===\n");
console.log(
  `  Overall accuracy: ${(report.overall.accuracy * 100).toFixed(1)}%` +
  ` (${report.overall.correct}/${report.overall.total})`,
);

const typeLabels: Record<string, string> = {
  "single-session-user":       "single-session-user      ",
  "single-session-assistant":  "single-session-assistant ",
  "single-session-preference": "single-session-preference",
  "multi-session":             "multi-session            ",
  "temporal-reasoning":        "temporal-reasoning       ",
  "knowledge-update":          "knowledge-update         ",
};

for (const [t, stats] of Object.entries(report.byType).sort(([a], [b]) => a.localeCompare(b))) {
  const label = typeLabels[t] ?? t.padEnd(25);
  console.log(
    `  ${label}: ${(stats.accuracy * 100).toFixed(1)}%` +
    ` (${stats.correct}/${stats.total})`,
  );
}

if (report.abstentionAccuracy) {
  const a = report.abstentionAccuracy;
  console.log(
    `\n  Abstention accuracy: ${(a.accuracy * 100).toFixed(1)}%` +
    ` (${a.correct}/${a.total}) — model correctly declined`,
  );
}

console.log();
console.log(
  `  Tokens: ${report.tokens.totalInputTokens.toLocaleString()} in / ` +
  `${report.tokens.totalOutputTokens.toLocaleString()} out`,
);
console.log(`  Wall-clock: ${(report.wallClockMs / 1000).toFixed(1)}s`);
if (report.errorCount > 0) console.log(`  Errors: ${report.errorCount}`);
console.log();

// ── Write outputs ──────────────────────────────────────────────────────────────

if (outPath) {
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`  JSON report → ${outPath}`);
}

const md = renderLongMemEvalReportMarkdown([report]);

if (mdPath) {
  await writeFile(mdPath, md, "utf-8");
  console.log(`  Markdown    → ${mdPath}`);
}

console.log("\n=== Markdown table ===\n");
console.log(md);
