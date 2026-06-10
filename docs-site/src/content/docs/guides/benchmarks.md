---
title: Benchmarks
description: Write-quality and temporal point-in-time benchmarks — what they measure, how to run them, and honest-methodology rules for publishing numbers.
---

The `@eidentic/bench` package ships two standalone benchmarks that complement retrieval-recall metrics by measuring the **write side** of memory:

- **Write-quality benchmark** (`runWriteQualityBench`) — contradiction suppression, junk resistance, duplicate resistance.
- **Temporal point-in-time benchmark** (`runTemporalBench`) — "what was X's property at a past date?" queries against the temporal knowledge graph.

Both benchmarks are deterministic and infrastructure-free (no real model, no network) when run against the built-in fixture sets. Results include cost-transparency fields alongside accuracy metrics.

---

## Honest-methodology rules

These rules apply to any numbers published using this harness. They are summarised from `packages/bench/BASELINES.md`.

1. **Harness-validation ≠ accuracy.** Numbers produced by the deterministic harness (mock model + in-memory store) prove the harness wires correctly but say nothing about real performance. Label them explicitly as **"harness-validation"** — never as accuracy numbers.
2. **Disclose model families.** Every published result must state which model family was used for extraction (the Consolidator) and, if an LLM judge graded answers, which judge model.
3. **Include a full-context baseline.** A memory system compared against a retrieval-free full-context window run is a valid benchmark design; omitting the comparison is not.
4. **Do not publish competitor numbers from your own runs.** Configuration choices (chunking, TTLs, extraction prompts, embedding models) critically affect results and you cannot guarantee fair configuration. Link to their own published numbers instead.
5. **Cost transparency triple is required.** Every published result must include `(metric, llmCallsPerWrite, tokensUsedIfAny)`. Accuracy alone is not publishable.

---

## Write-quality benchmark

### What it measures

Retrieval benchmarks only test what comes back out. The write-quality benchmark tests three properties of what goes **in**:

| Metric | Direction | Meaning |
|---|---|---|
| `contradictionAccuracy` | ↑ higher is better | Fraction of contradiction pairs where the current fact wins and the stale fact is invalidated |
| `junkRate` | ↓ lower is better | Fraction of junk items that were stored (`junk stored / junk fed`) |
| `factRecall` | ↑ higher is better | Fraction of real facts that were stored and are queryable (`real facts stored / real facts fed`) |
| `duplicateRate` | ↓ lower is better | Fraction of re-ingested duplicate events that created an extra copy (`extra copies / re-ingest events`) |
| `llmCallsPerWrite` | transparency | Average LLM calls per ingest write (0 in deterministic harness) |
| `tokensUsedIfAny` | transparency | Total tokens consumed across all LLM calls (0 in deterministic harness) |

### Running the benchmark

```ts
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryGraph } from "@eidentic/types/testing";
import { runWriteQualityBench } from "@eidentic/bench";

const store = new InMemoryStore();
const memory = new Memory({ store, graph: store });

const report = await runWriteQualityBench(memory);

console.log("contradictionAccuracy:", report.contradictionAccuracy); // 1.0
console.log("junkRate:",             report.junkRate);              // 0.0
console.log("factRecall:",           report.factRecall);            // 1.0
console.log("duplicateRate:",        report.duplicateRate);         // 0.0
console.log("llmCallsPerWrite:",     report.llmCallsPerWrite);      // 0
console.log("tokensUsedIfAny:",      report.tokensUsedIfAny);       // 0
```

### Built-in fixtures

`CONTRADICTION_FIXTURES` — five pairs covering employer, city, role, and language for two subjects. Each pair has an earlier stale value and a later current value with explicit ISO `validFrom` timestamps. The benchmark asserts both in order and verifies that only the current object is active.

`JUNK_STREAM_FIXTURES` — sixteen items split into four real user facts and twelve junk items across four junk sub-kinds:

| Sub-kind | Count | Example |
|---|---|---|
| `system-prompt` | 3 | `"[SYSTEM] You are a helpful assistant…"` |
| `tool-output` | 3 | `'Tool result: {"status": "ok", "rows": 42…}'` |
| `transient-state` | 3 | `"Currently processing your request…"` |
| `agent-scratchpad` | 3 | `"Let me think about this step by step…"` |

You can supply your own fixtures via `WriteQualityOptions`:

```ts
const report = await runWriteQualityBench(memory, {
  contradictionFixtures: myContraFix,
  junkStreamFixtures: myJunkStream,
  duplicateSessions: 5,         // default 3 — number of times to re-ingest the same events
  scope: { kind: "user", userId: "bench-user" },
});
```

### How each metric is computed

**Contradiction suppression.** For each fixture pair, the stale fact is asserted first, then the current fact. The score is 1 if (a) `asserted.object` equals the current value with no `validUntil`, (b) the stale value appears in `invalidated`, and (c) `queryFacts` returns only the current value as active.

**Junk resistance.** The benchmark simulates the extraction pipeline's REJECT gate: real facts are passed to `assertFact`, junk items are not. `junkRate = junk items stored / junk items fed`. In a correctly-operating system the gate prevents junk from reaching `assertFact`; in a real-LLM run the Consolidator's classification accuracy determines the real `junkRate`.

**Duplicate resistance.** A set of reference events is ingested once (session 1), then the same texts are re-ingested under new event ids across `duplicateSessions − 1` more sessions. `Memory.ingest` with `dedupeOnWrite: true` (the default) suppresses exact-text duplicates. `duplicateRate = extra copies / total re-ingest events`.

### Per-item detail

`report.details` is an array of `WriteQualityDetail` entries — one per fixture item. Each entry has `kind`, `label`, `passed`, and an optional `note` on failure:

```ts
for (const d of report.details.filter((d) => !d.passed)) {
  console.error(d.kind, d.label, d.note);
}
```

---

## Temporal point-in-time benchmark

### What it measures

The temporal benchmark evaluates whether a memory system can answer "what was X's `<property>` at `<date>`?" — a question that requires **timestamped fact validity** (`validFrom` / `validUntil`). A system that stores facts without temporal intervals always returns the current state and cannot pass this benchmark.

| Metric | Direction | Meaning |
|---|---|---|
| `pointInTimeAccuracy` | ↑ higher is better | Accuracy on questions with `askedAt` before or between known states (excludes current-state questions) |
| `currentStateAccuracy` | ↑ higher is better | Accuracy on questions asking for the latest / current state |
| `beforeFirstFactAccuracy` | ↑ higher is better | Accuracy on questions asked before the first known fact — correct answer is `null` |
| `totalQuestions` | info | Total questions evaluated |
| `llmCallsPerWrite` | transparency | Always 0 (deterministic) |
| `tokensUsedIfAny` | transparency | Always 0 (deterministic) |

### Running the benchmark

```ts
import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryGraph } from "@eidentic/types/testing";
import { runTemporalBench, syntheticTemporalDataset } from "@eidentic/bench";

const store = new InMemoryStore();
const memory = new Memory({ store, graph: store });

const dataset = syntheticTemporalDataset({ seed: 42, entityCount: 4 });
const report = await runTemporalBench(memory, dataset);

console.log("pointInTimeAccuracy:    ", report.pointInTimeAccuracy);    // 1.0
console.log("currentStateAccuracy:   ", report.currentStateAccuracy);   // 1.0
console.log("beforeFirstFactAccuracy:", report.beforeFirstFactAccuracy); // 1.0
console.log("totalQuestions:         ", report.totalQuestions);          // 64
```

### Synthetic temporal dataset

`syntheticTemporalDataset({ seed, entityCount })` generates a deterministic dataset of entities with state histories (employer, city, preference) evolving at known timestamps. The same `seed` always produces the same entities, timelines, and question/answer pairs.

The dataset object contains:
- `asserts` — `AssertFactInput[]` ready to pass to `memory.assertFact`, ordered ascending by `validFrom`.
- `questions` — `TemporalQuestion[]` with gold answers covering four question types.

#### Question types

| Type | Description | Correct answer |
|---|---|---|
| `before-first-fact` | `askedAt` predates any known fact | `null` |
| `at-boundary` | `askedAt` equals the exact `validFrom` of a transition | The new value at that transition |
| `mid-interval` | `askedAt` falls between two transitions | The value valid during that interval |
| `current-state` | `askedAt` is after the last known transition | The latest value |

At `seed=42, entityCount=4`, the dataset produces 64 questions (16 of each type across 4 entities × 2 predicates × 2 question points).

### Per-question results

`report.results` gives a full breakdown:

```ts
for (const r of report.results.filter((r) => !r.correct)) {
  console.error(r.questionType, r.subject, r.predicate, "at", r.askedAt);
  console.error("  gold:", r.goldAnswer, "  got:", r.systemAnswer);
}
```

### Why retrieval-only systems fail

A system without timestamped fact validity (no `validFrom`/`validUntil`) will:
- Score ~1.0 on `currentStateAccuracy` by accident (the latest ingested chunk happens to match).
- Score ~0.0 on `beforeFirstFactAccuracy` (cannot return `null` — always returns the current value).
- Score ~0.0 on `mid-interval` questions (always returns the latest value instead of the historically-correct one).

The benchmark's three-metric split makes this failure mode explicit and measurable.

---

## Harness-validation numbers

These numbers are produced by the deterministic harness. They prove the harness is wired correctly and are reproducible on any machine. **They are not real-LLM accuracy numbers.**

### Write-quality (deterministic harness)

| Metric | Value | Notes |
|---|---|---|
| `contradictionAccuracy` | 1.00 | 5/5 fixtures: current fact wins, stale invalidated |
| `junkRate` | 0.00 | 0/12 junk items stored (correctly suppressed) |
| `factRecall` | 1.00 | 4/4 real facts stored and queryable |
| `duplicateRate` | 0.00 | 0/8 re-ingested texts created duplicates |
| `llmCallsPerWrite` | 0 | Deterministic harness — no model calls |
| `tokensUsedIfAny` | 0 | Deterministic harness — no tokens consumed |

### Temporal point-in-time (deterministic, seed=42, entities=4)

| Metric | Value | Questions | Notes |
|---|---|---|---|
| `pointInTimeAccuracy` | 1.00 | 48 | before-first + at-boundary + mid-interval |
| `currentStateAccuracy` | 1.00 | 16 | latest state queries |
| `beforeFirstFactAccuracy` | 1.00 | 16 | `askedAt` before any known fact → null answer |
| `llmCallsPerWrite` | 0 | — | Deterministic harness |
| `tokensUsedIfAny` | 0 | — | Deterministic harness |

---

## Real datasets (gated)

The real datasets are not bundled (large + license-bound). Download them independently and use the loaders:

```ts
import { loadLongMemEval, loadLoCoMo, runMemoryBench } from "@eidentic/bench";

// LongMemEval — https://github.com/xiaowu0162/LongMemEval
const dataset = await loadLongMemEval("/path/to/longmemeval.json");
const report = await runMemoryBench(() => memory, dataset, { topK: 10 });
console.log("recall@10:", report.recallAtK.mean);

// LoCoMo — https://github.com/snap-research/locomo
const locomoDataset = await loadLoCoMo("/path/to/locomo.json");
```

Or pass an environment variable and run via vitest:

```bash
EIDENTIC_BENCH_LONGMEMEVAL=/path/to/longmemeval.json npx vitest run packages/bench/test/bench.live.test.ts
```

---

## See also

- [Memory 101](/guides/memory) — core memory layers
- [Memory Governance](/guides/memory-governance) — the governance features these benchmarks exercise
- [Evals in CI](/guides/evals-ci) — how to integrate recall benchmarks into your CI pipeline
