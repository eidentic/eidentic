/**
 * LoCoMo benchmark runner — real LLM pilot.
 *
 * Runs the LoCoMo fair-run benchmark harness against the downloaded dataset.
 * Requires data/locomo10.json at the project root (gitignored; CC BY-NC 4.0).
 *
 * Usage:
 *   OPENAI_API_KEY=... tsx examples/bench-locomo.ts [flags]
 *
 * Flags:
 *   --mode memory|full-context   (default: full-context)
 *   --samples N                  (default: all 10; use small N for a quick pilot)
 *   --questions N                cap questions per sample
 *   --categories 1,2,3,4,5      comma-separated list (default: all)
 *   --out report.json            write the full JSON report
 *   --md report.md               write a Markdown results table
 *   --topk N                     snippets retrieved per question in memory mode (max 10)
 *   --seed N                     PRNG seed for reproducibility (default: 42)
 *   --checkpoint path.jsonl      resume an interrupted run from this checkpoint file
 *
 * The script always prints the Markdown table to stdout at the end.
 *
 * NOTE: ANTHROPIC_API_KEY is required. To use a different provider, replace the
 * `anthropic(...)` calls below with your provider's adapter wrapped in AIModel.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openai } from "@ai-sdk/openai";
import { AIModel } from "@eidentic/model";
import { LocalEmbedder } from "@eidentic/transformers";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore } from "@eidentic/types/testing";
import {
  loadLoCoMo,
  runLocomoBench,
  renderLocomoReportMarkdown,
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
const sampleLimit = flagNum("--samples", 10);
const questionLimit = process.argv.includes("--questions")
  ? flagNum("--questions", 0) || undefined
  : undefined;
const categoriesArg = flagStr("--categories", "1,2,3,4,5");
const categories = categoriesArg.split(",").map(Number).filter((n) => n >= 1 && n <= 5);
const outPath = process.argv.includes("--out") ? flagStr("--out", "report.json") : undefined;
const mdPath = process.argv.includes("--md") ? flagStr("--md", "report.md") : undefined;
const topK = Math.min(flagNum("--topk", 10), 10);
const seed = flagNum("--seed", 42);
const checkpointPath = process.argv.includes("--checkpoint")
  ? flagStr("--checkpoint", "locomo-checkpoint.jsonl")
  : undefined;

// ── Setup ──────────────────────────────────────────────────────────────────────

const DATA_PATH = resolve(process.cwd(), "data/locomo10.json");

if (!process.env["OPENAI_API_KEY"]) {
  console.error(
    "Error: OPENAI_API_KEY is required.\n" +
    "Set the env var and re-run:\n" +
    "  OPENAI_API_KEY=... tsx examples/bench-locomo.ts",
  );
  process.exit(1);
}

console.log("=== LoCoMo Benchmark Pilot ===\n");
console.log(`  Mode:        ${mode}`);
console.log(`  Samples:     ${sampleLimit}`);
console.log(`  Questions:   ${questionLimit ?? "all"}`);
console.log(`  Categories:  ${categories.join(", ")}`);
console.log(`  topK:        ${topK} (memory mode)`);
console.log(`  Seed:        ${seed}`);
if (checkpointPath) console.log(`  Checkpoint:  ${checkpointPath}`);
console.log();

// ── Models ──────────────────────────────────────────────────────────────────────

// Answer model: claude-haiku-4-5 for cost-effective piloting
// Replace with claude-sonnet-4-5 or another model for production runs
const answerModel = new AIModel(openai(process.env["EIDENTIC_BENCH_ANSWER_MODEL"] ?? "gpt-4o-mini"));
answerModel.modelId = process.env["EIDENTIC_BENCH_ANSWER_MODEL"] ?? "gpt-4o-mini";

// Judge model: claude-sonnet-4-5 for strict, capable judging
const judgeModel = new AIModel(openai(process.env["EIDENTIC_BENCH_JUDGE_MODEL"] ?? "gpt-4o-mini"));
judgeModel.modelId = process.env["EIDENTIC_BENCH_JUDGE_MODEL"] ?? "gpt-4o-mini";

// ── Memory factory (used only when mode="memory") ──────────────────────────────

const localEmbedder = await LocalEmbedder.create();

function memoryFactory(): Memory {
  return new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: localEmbedder,
  });
}

// ── Load dataset ─────────────────────────────────────────────────────────────────

console.log("Loading dataset ...");
const dataset = await loadLoCoMo(DATA_PATH);
console.log(`  Loaded ${dataset.samples.length} samples\n`);

// ── Run ────────────────────────────────────────────────────────────────────────

let doneCount = 0;
const totalQ = dataset.samples
  .slice(0, sampleLimit)
  .flatMap((s) => s.qa)
  .filter((q) => categories.includes(q.category)).length;

const report = await runLocomoBench({
  dataPath: DATA_PATH,
  dataset,
  answerModel,
  judgeModel,
  mode,
  categories,
  sampleLimit,
  questionLimit,
  seed,
  topK,
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
console.log(`  Overall J(1-4): ${(report.overallJ14.accuracy * 100).toFixed(1)}% (${report.overallJ14.correct}/${report.overallJ14.total})`);

for (const [cat, stats] of Object.entries(report.byCategory).sort(([a], [b]) => Number(a) - Number(b))) {
  const catNames: Record<string, string> = {
    "1": "multi-hop",
    "2": "temporal",
    "3": "open-domain",
    "4": "single-hop",
    "5": "adversarial",
  };
  const name = catNames[cat] ?? cat;
  console.log(`  Cat ${cat} (${name.padEnd(11)}): ${(stats.accuracy * 100).toFixed(1)}% (${stats.correct}/${stats.total})`);
}

if (report.cat5RefusalRate) {
  const r = report.cat5RefusalRate;
  console.log(`  Cat5 refusal rate: ${(r.rate * 100).toFixed(1)}% (${r.correct}/${r.total})`);
}

console.log();
console.log(`  Tokens: ${report.tokens.totalInputTokens.toLocaleString()} in / ${report.tokens.totalOutputTokens.toLocaleString()} out`);
console.log(`  Wall-clock: ${(report.wallClockMs / 1000).toFixed(1)}s`);
if (report.errorCount > 0) console.log(`  Errors: ${report.errorCount}`);
console.log();

// ── Write outputs ───────────────────────────────────────────────────────────────

if (outPath) {
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`  JSON report → ${outPath}`);
}

const md = renderLocomoReportMarkdown([report]);

if (mdPath) {
  await writeFile(mdPath, md, "utf-8");
  console.log(`  Markdown    → ${mdPath}`);
}

// Always print markdown to stdout
console.log("\n=== Markdown table ===\n");
console.log(md);
