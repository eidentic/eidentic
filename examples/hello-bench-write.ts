/**
 * Write-quality + temporal benchmark demo — infra-free.
 *
 * Runs three write-side benchmarks that retrieval-only harnesses miss:
 *
 *   1. Contradiction suppression — stale facts should be invalidated when newer ones arrive.
 *   2. Junk resistance  — system-prompt dumps, tool outputs, transient chatter → not stored.
 *   3. Duplicate resistance — re-ingesting the same events should not inflate the store.
 *   4. Temporal point-in-time QA — "what was X's employer at date Y?" using validAt queries.
 *
 * No LLM, no external infrastructure, no network calls. Runs in ~100ms.
 *
 * Run:  pnpm hello:bench-write
 */
import { Memory } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";
import {
  runWriteQualityBench,
  runTemporalBench,
  syntheticTemporalDataset,
} from "@eidentic/bench";

function makeGraphMemory(): Memory {
  const store = new InMemoryStore();
  return new Memory({ store, graph: store });
}

async function main() {
  // ── Write-quality benchmark ──────────────────────────────────────────────────────────────────
  console.log("=== Write-Quality Benchmark (infra-free) ===\n");

  const writeReport = await runWriteQualityBench(makeGraphMemory());

  console.log("Contradiction suppression:");
  console.log(`  contradictionAccuracy : ${(writeReport.contradictionAccuracy * 100).toFixed(1)}%`);

  console.log("\nJunk resistance:");
  console.log(`  junkRate              : ${(writeReport.junkRate * 100).toFixed(1)}%  (want 0%)`);
  console.log(`  factRecall            : ${(writeReport.factRecall * 100).toFixed(1)}%  (want 100%)`);

  console.log("\nDuplicate resistance:");
  console.log(`  duplicateRate         : ${(writeReport.duplicateRate * 100).toFixed(1)}%  (want 0%)`);

  console.log("\nCost transparency (deterministic harness):");
  console.log(`  llmCallsPerWrite      : ${writeReport.llmCallsPerWrite}`);
  console.log(`  tokensUsedIfAny       : ${writeReport.tokensUsedIfAny}`);

  console.log(`\nDetail entries         : ${writeReport.details.length} items`);
  const passed = writeReport.details.filter((d) => d.passed).length;
  const failed = writeReport.details.filter((d) => !d.passed).length;
  console.log(`  passed: ${passed}  failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed items:");
    for (const d of writeReport.details.filter((d) => !d.passed)) {
      console.log(`  [${d.kind}] ${d.label}: ${d.note ?? ""}`);
    }
  }

  // ── Temporal point-in-time benchmark ────────────────────────────────────────────────────────
  console.log("\n=== Temporal Point-in-Time Benchmark (infra-free) ===\n");

  const temporalDs = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
  const temporalReport = await runTemporalBench(makeGraphMemory(), temporalDs);

  console.log(`Dataset: ${temporalReport.datasetName}`);
  console.log(`Total questions: ${temporalReport.totalQuestions}`);
  console.log("");
  console.log("Metrics:");
  console.log(
    `  pointInTimeAccuracy   : ${(temporalReport.pointInTimeAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  currentStateAccuracy  : ${(temporalReport.currentStateAccuracy * 100).toFixed(1)}%`,
  );
  console.log(
    `  beforeFirstFact       : ${(temporalReport.beforeFirstFactAccuracy * 100).toFixed(1)}%`,
  );

  console.log("\nCost transparency (deterministic harness):");
  console.log(`  llmCallsPerWrite      : ${temporalReport.llmCallsPerWrite}`);
  console.log(`  tokensUsedIfAny       : ${temporalReport.tokensUsedIfAny}`);

  // Show a sample of results by question type
  console.log("\nSample results by question type:");
  const byType = new Map<string, typeof temporalReport.results>();
  for (const r of temporalReport.results) {
    const list = byType.get(r.questionType) ?? [];
    list.push(r);
    byType.set(r.questionType, list);
  }
  for (const [type, results] of byType) {
    const correct = results.filter((r) => r.correct).length;
    const sample = results[0]!;
    console.log(
      `  ${type.padEnd(20)} ${correct}/${results.length} correct  ` +
        `e.g. ${sample.subject}.${sample.predicate} at ${sample.askedAt.slice(0, 10)} → ${sample.goldAnswer ?? "(none)"}`,
    );
  }

  console.log("\n=== Summary ===");
  console.log(
    "All benchmarks are infra-free and deterministic. Numbers above are harness-validation",
  );
  console.log(
    "baselines (MockModel + InMemoryStore). Run with a real model + real vector store to",
  );
  console.log("get publishable accuracy numbers — and always disclose your extraction model.");
  console.log("\n=== Done ===");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
