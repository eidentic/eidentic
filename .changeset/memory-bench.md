---
"@eidentic/bench": minor
---

feat: @eidentic/bench — runnable memory benchmark harness (§6.10)

New package `@eidentic/bench`:

- `recallAtK`: deterministic recall metric (no model) — fraction of gold facts found as normalized
  substrings in top-K retrieved context. Case/punctuation insensitive.
- `runMemoryBench(makeMemory, dataset, opts)`: drives a fresh Memory per case, ingests turns, runs
  retrieval questions, aggregates into a `BenchReport` with overall + per-category recall@k.
- `syntheticDataset`: bundled 5-case dataset covering single-session, multi-session, temporal, and
  knowledge-update categories — runs in CI without real models or large files.
- `loadLongMemEval` / `loadLoCoMo`: gated loaders for real datasets (not bundled; user provides path).
- CI baseline regression gate in `bench.test.ts`: semantic recall@8 on syntheticDataset must be
  >= 0.75 (measured ~0.88). Fails if the memory pipeline regresses.
- Optional LLM judge for answer-correctness scoring (gated by `opts.judge` ModelPort).
- `BASELINES.md`: published baseline numbers + instructions for running real datasets.
