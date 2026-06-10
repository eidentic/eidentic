---
"@eidentic/eval": minor
---

New `@eidentic/eval` package: a first-class, in-repo agent **evaluation harness** (§11.3) — the
production fundamental no major framework ships. Drives dataset cases through a runner, derives a
stable **trajectory** from the session event log (the trace, §9.1/§11.1), and scores it with
**deterministic** + **LLM-as-judge** scorers, returning an `EvalReport` (per-case + aggregate).

- **`evaluate(runner, dataset, { scorers, samples?, toolSchemas? })`** — runs each case (× `samples`,
  for stable trajectory metrics), normalizes the event log via `trajectoryFromEvents`, applies the
  scorers, aggregates mean + pass-rate per scorer. Satisfiable by a core `Agent` via the structural
  `agentRunner(agent, store)` adapter (eval's only runtime dep is `@eidentic/types`).
- **Deterministic scorers** (`trajectory.*`, sync/pure): `toolCorrectness`, `requiredParams`,
  `schemaValidity`, `idempotencyKeyPresence`, `toolSequence`, `stepEfficiency`, `verifierStall`
  (>N same-name tool spans — the "verifier stall" failure mode), `noRepeatedSteps` (step-repetition,
  17% of failures). A `scorerConformanceCases()` suite mirrors the adapter-conformance pattern.
- **LLM-as-judge scorers** (`llmJudge.*`): `taskCompletion`, `planQuality`, `faithfulness`,
  `answerRelevancy`. Each takes a JUDGE `ModelPort` that MUST be a different model than the agent
  (no self-bias, Constitution #6), asks for a structured `{score, rationale}` tool call, **clamps
  the score to [0,1]**, and **fails closed** (`{score:0, passed:false}`) on any malformed/missing
  output — never throws.
- **Failure→regression loop:** `captureFailure(session, { groundTruth })` turns a failed session
  into a reusable `DatasetCase`. `groundTruth` is a REQUIRED human input — the agent never writes
  its own (the locked-in-bugs anti-pattern). Tiny std-lib JSONL `loadDatasetJsonl`/`saveDatasetJsonl`
  (no new deps); records are friendly to OTel / standard eval datasets.

Deferred: the memory benchmark harness (§6.10 LongMemEval/LoCoMo — a separate plan that consumes
this), CI regression baselines / published-baseline tracking (§18.5), external eval/observability
adapters, declarative YAML config, and live-model judge tests.
