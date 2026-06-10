/**
 * Gated live tests for real datasets (LongMemEval, LoCoMo).
 *
 * These tests are SKIPPED unless the corresponding env var points to a real dataset file:
 *   EIDENTIC_BENCH_LONGMEMEVAL=/path/to/longmemeval.json
 *   EIDENTIC_BENCH_LOCOMO=/path/to/locomo.json
 *
 * The real datasets are large and license-bound, so they are not bundled in the repository.
 * See packages/bench/BASELINES.md for download instructions.
 *
 * To run these tests:
 *   EIDENTIC_BENCH_LONGMEMEVAL=/path/to/file npx vitest run packages/bench/test/bench.live.test.ts
 */
import { describe, it, expect } from "vitest";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import { runMemoryBench } from "../src/run.js";
import { loadLongMemEval, loadLoCoMo } from "../src/loaders.js";

const LONGMEMEVAL_PATH = process.env["EIDENTIC_BENCH_LONGMEMEVAL"];
const LOCOMO_PATH = process.env["EIDENTIC_BENCH_LOCOMO"];

function makeSemanticMemory(): Memory {
  return new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: new FakeEmbedder(32),
  });
}

describe("LongMemEval live benchmark (gated)", () => {
  it.skipIf(!LONGMEMEVAL_PATH)(
    "loads and runs LongMemEval, recall@8 in [0,1]",
    async () => {
      const dataset = await loadLongMemEval(LONGMEMEVAL_PATH!);
      expect(dataset.cases.length).toBeGreaterThan(0);
      const report = await runMemoryBench(() => makeSemanticMemory(), dataset, { topK: 8 });
      expect(report.recallAtK.mean).toBeGreaterThanOrEqual(0);
      expect(report.recallAtK.mean).toBeLessThanOrEqual(1);
      console.info("[LongMemEval] recall@8 mean:", report.recallAtK.mean, "n:", report.recallAtK.n);
      console.info("[LongMemEval] byCategory:", report.byCategory);
    },
    // Allow up to 5 minutes for a large dataset
    300_000,
  );
});

describe("LoCoMo live benchmark (gated)", () => {
  it.skipIf(!LOCOMO_PATH)(
    "loads and runs LoCoMo, recall@8 in [0,1]",
    async () => {
      const dataset = await loadLoCoMo(LOCOMO_PATH!);
      expect(dataset.cases.length).toBeGreaterThan(0);
      const report = await runMemoryBench(() => makeSemanticMemory(), dataset, { topK: 8 });
      expect(report.recallAtK.mean).toBeGreaterThanOrEqual(0);
      expect(report.recallAtK.mean).toBeLessThanOrEqual(1);
      console.info("[LoCoMo] recall@8 mean:", report.recallAtK.mean, "n:", report.recallAtK.n);
      console.info("[LoCoMo] byCategory:", report.byCategory);
    },
    300_000,
  );
});
