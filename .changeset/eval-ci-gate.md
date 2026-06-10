---
"@eidentic/eval": minor
"@eidentic/cli": minor
---

Add CI-gate support to `@eidentic/eval` and `eidentic eval` CLI command.

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
