# @eidentic/eval

## 0.1.0

### Minor Changes

- 3a605b5: Clarify public API names (pre-1.0 renames):

  - `LanceVectorStore` → `LanceDBVectorStore` (`@eidentic/lancedb`)
  - `agentRunner` → `createRunner` (`@eidentic/eval`)
  - `discoveryTools` → `lazyDiscoveryTools` (`@eidentic/core`)
  - `dedupeArchival` → `deduplicateArchival` (`@eidentic/memory` — method on `Memory` + `ConsolidationScheduler`)
  - `NoneSandbox` → `NoopSandbox` (`@eidentic/core`)
  - `EAGER_CORE` → `EAGER_TOOL_IDS` (`@eidentic/core`)
  - `globMatch` → `matchSkillGlob` (`@eidentic/skills` only; `@eidentic/core`'s `globMatch` is unchanged)

  Tooling bump (root dev dependency, no changeset required):

  - `typescript` `^5.7.0` → `^5.9.0`

  Note: `@electric-sql/pglite` bump to `^0.5.0` was attempted but reverted — pglite 0.5 removed
  the `./vector` sub-path entirely (pgvector no longer bundled, no standalone replacement package
  available as of 2026-06-07). Staying on `^0.4.6` until upstream ships a compatible upgrade path.

- 3a605b5: Add CI-gate support to `@eidentic/eval` and `eidentic eval` CLI command.

  **`@eidentic/eval`**

  - **`assertPassRate(report, threshold, opts?): void`** — throws `EvalThresholdError` when the
    aggregate pass rate (mean of per-scorer pass fractions from `report.aggregate`) is below
    `threshold` (0–1). The error carries `actualPassRate`, `requiredPassRate`, and `failedCases`
    (per-case pass rates for cases below threshold). Returns cleanly otherwise.
    Optional `opts.scorers` restricts the check to a named subset of scorers.
  - **`summarize(report): string`** — human-readable, CI-friendly text summary: aggregate per-scorer
    pass/mean/n, then a per-case breakdown with individual pass rates and any runner errors surfaced.
  - **`EvalThresholdError`** — typed error class (name `"EvalThresholdError"`) with machine-readable
    fields so callers can format their own output or re-throw.

  **`@eidentic/cli`**

  - **`eidentic eval <config>`** — new subcommand. Loads an eval config file (`.ts`/`.js`/`.mjs`) via
    jiti (same mechanism as `eidentic dev`), runs the eval, prints the summary, and exits 0.
    The config file must export `{ runner, dataset, scorers, samples? }`.
  - **`--ci`** flag — enables the CI gate: exits non-zero with a clear error message when the
    aggregate pass rate is below `--threshold` (default 1.0).
  - **`--threshold <n>`** (`-t`) — pass-rate threshold in [0, 1] (e.g. `--threshold 0.8` = 80 %).

  Pure helpers `computePassRate` and `evalGateCheck` are also exported from `commands.ts` for
  programmatic use and testability without process.exit.

- 3a605b5: New `@eidentic/eval` package: a first-class, in-repo agent **evaluation harness** (§11.3) — the
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

- 3a605b5: Add `promoteTraceToEvalCase` and `collectPromotedCases` — trace promotion API for closing the prod→eval loop.

  **`promoteTraceToEvalCase(events, opts?): DatasetCase`** — turns a captured production trace (`StoredEvent[]`) into an `EvalCase` the existing runner and scorers can execute directly. Extracts the user input from the first `user` event and the observed final assistant text as a regression baseline in `groundTruth` (`useObservedAsBaseline: true` by default — set `false` to leave it blank for human labeling). Provenance is recorded on `DatasetCase.meta` (`sourceRunId`, `promotedAt`, `tags`); the original events are preserved in `capturedEvents` for replay/inspection. Throws a descriptive error on an empty or non-array trace so callers fail fast.

  **`collectPromotedCases(name, cases): EvalDataset`** — assemble multiple promoted cases into an `EvalDataset` ready for `evaluate()`.

  **`DatasetCase.meta`** — new optional field (`Record<string, unknown>`) for arbitrary provenance metadata; transparent to the runner/scorers and round-trips cleanly through `saveDatasetJsonl` / `loadDatasetJsonl`.

  Pure/in-memory and store-agnostic — input is a trace array, output is an `EvalCase`. Persistence is left to the caller.

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

### Patch Changes

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/types@0.1.0
