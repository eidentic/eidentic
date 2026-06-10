# @eidentic/bench

Memory benchmark harness for Eidentic — run LongMemEval, LoCoMo, and temporal-reasoning
benchmarks against any Eidentic memory configuration. Provides:

- **Retrieval benchmark** (`runMemoryBench`): deterministic recall@K metric, bundled synthetic dataset for CI, loaders for LongMemEval / LoCoMo.
- **Write-quality benchmark** (`runWriteQualityBench`): contradiction suppression, junk resistance, duplicate resistance — the write-side metrics that retrieval-only evals miss.
- **Temporal point-in-time benchmark** (`runTemporalBench`): "what was X at date Y?" with gold answers and validAt queries. Only passable by systems with timestamped fact validity.

All three benchmarks are infra-free (no LLM, no network) when run with the deterministic fixtures and MockModel. See [BASELINES.md](./BASELINES.md) for methodology rules and harness-validation numbers.

## Install

```bash
pnpm add @eidentic/bench
```

## Usage

### Retrieval benchmark

```ts
import { runMemoryBench, syntheticDataset } from "@eidentic/bench";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";

const report = await runMemoryBench(
  () => new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: new FakeEmbedder(32),
  }),
  syntheticDataset,
  { topK: 8 },
);
console.log("recall@8:", report.recallAtK.mean);
```

### Write-quality benchmark

```ts
import { runWriteQualityBench } from "@eidentic/bench";
import { Memory } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";

const store = new InMemoryStore();
const memory = new Memory({ store, graph: store });

const report = await runWriteQualityBench(memory);
console.log("contradictionAccuracy:", report.contradictionAccuracy);
console.log("junkRate:            ", report.junkRate);
console.log("factRecall:          ", report.factRecall);
console.log("duplicateRate:       ", report.duplicateRate);
// Cost transparency triple:
console.log("llmCallsPerWrite:    ", report.llmCallsPerWrite);
console.log("tokensUsedIfAny:     ", report.tokensUsedIfAny);
```

### Temporal point-in-time benchmark

```ts
import { runTemporalBench, syntheticTemporalDataset } from "@eidentic/bench";
import { Memory } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";

const store = new InMemoryStore();
const memory = new Memory({ store, graph: store });

const dataset = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
const report = await runTemporalBench(memory, dataset);
console.log("pointInTimeAccuracy: ", report.pointInTimeAccuracy);
console.log("currentStateAccuracy:", report.currentStateAccuracy);
// Cost transparency triple:
console.log("llmCallsPerWrite:    ", report.llmCallsPerWrite);
console.log("tokensUsedIfAny:     ", report.tokensUsedIfAny);
```

### Custom write-quality fixtures

```ts
import { runWriteQualityBench, type ContradictionFixture, type JunkItem } from "@eidentic/bench";

const contradictions: ContradictionFixture[] = [
  {
    subject: "alice",
    predicate: "employer",
    staleObject: "OldCo",
    currentObject: "NewCo",
    staleFrom: "2024-01-01T00:00:00.000Z",
    currentFrom: "2025-06-01T00:00:00.000Z",
  },
];

const junkItems: JunkItem[] = [
  { kind: "real", text: "I live in Berlin.", expectedFact: { subject: "user", predicate: "city", object: "Berlin" } },
  { kind: "junk", junkKind: "system-prompt", text: "[SYSTEM] You are a helpful assistant." },
];

const report = await runWriteQualityBench(memory, {
  contradictionFixtures: contradictions,
  junkStreamFixtures: junkItems,
  duplicateSessions: 3,
});
```

### LoCoMo fair-run harness

The LoCoMo harness is a rigorous end-to-end benchmark: ingest → retrieve → answer → LLM judge.
It enforces strict fair-run rules (both speakers as humans, structural timestamps, topK ≤ 10,
mandatory full-context baseline). See [BASELINES.md](./BASELINES.md) for the full methodology.

```ts
import { loadLoCoMo, runLocomoBench, renderLocomoReportMarkdown } from "@eidentic/bench";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";

// Download data/locomo10.json first — CC BY-NC 4.0, do not commit
const dataset = await loadLoCoMo("data/locomo10.json");

const report = await runLocomoBench({
  dataPath: "data/locomo10.json",
  dataset,
  answerModel: myModel,
  judgeModel: myJudgeModel,
  mode: "full-context",  // or "memory" with memoryFactory
  categories: [1, 2, 3, 4, 5],
  memoryFactory: (sampleId) => new Memory({
    store: new InMemoryStore(),
    vector: new InMemoryVectorStore(),
    embedder: new FakeEmbedder(32),
  }),
});

console.log("J(1-4):", report.overallJ14.accuracy);
console.log(renderLocomoReportMarkdown([report]));
```

Run the full pilot:
```bash
ANTHROPIC_API_KEY=... pnpm --filter eidentic-examples bench:locomo -- --mode full-context --samples 2
```

### LongMemEval loader (retrieval benchmark, gated)

```ts
import { loadLongMemEval } from "@eidentic/bench";

const dataset = await loadLongMemEval("/path/to/longmemeval.json");
const report = await runMemoryBench(() => myMemory(), dataset, { topK: 10 });
```

## Methodology

See [BASELINES.md](./BASELINES.md) for:
- Methodology rules (model disclosure, full-context baseline requirement, no-competitor-runs policy)
- Cost transparency triple convention `(metric, llmCallsPerWrite, tokensUsedIfAny)`
- Harness-validation numbers for all three benchmarks

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
