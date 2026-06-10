/**
 * Memory benchmark harness demo (§6.10) — infra-free.
 *
 *  1. Run runMemoryBench over syntheticDataset with a semantic Memory
 *     (InMemoryStore + InMemoryVectorStore + FakeEmbedder).
 *  2. Print the BenchReport: recall@k overall + by category + per-case breakdown.
 *
 * Run:  pnpm hello:bench
 */
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import { runMemoryBench, syntheticDataset } from "@eidentic/bench";

async function main() {
  console.log("=== Eidentic Memory Benchmark (synthetic dataset) ===\n");

  const report = await runMemoryBench(
    () =>
      new Memory({
        store: new InMemoryStore(),
        vector: new InMemoryVectorStore(),
        embedder: new FakeEmbedder(32),
      }),
    syntheticDataset,
    { topK: 8 },
  );

  // Overall
  console.log(`Dataset: ${report.dataset}`);
  console.log(`Overall recall@8: ${(report.recallAtK.mean * 100).toFixed(1)}%  (n=${report.recallAtK.n} questions)\n`);

  // By category
  console.log("By category:");
  for (const [cat, stats] of Object.entries(report.byCategory)) {
    console.log(`  ${cat.padEnd(20)} ${(stats.mean * 100).toFixed(1)}%  (n=${stats.n})`);
  }
  console.log();

  // Per case
  console.log("Per case:");
  for (const c of report.perCase) {
    console.log(`  ${c.caseId.padEnd(35)} recall@8=${(c.recallAtK.mean * 100).toFixed(1)}%`);
    for (const q of c.questions) {
      const found = `${q.foundFacts}/${q.totalFacts}`;
      console.log(`    [${(q.category ?? "?").padEnd(17)}] ${found} facts  "${q.question.slice(0, 60)}"`);
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
