---
title: Evals in CI
description: "@eidentic/eval — eidentic eval CLI flags, compareReports, regression gating, and the GitHub Actions workflow."
---

`@eidentic/eval` is the evaluation harness for measuring agent quality. The `eidentic eval` CLI runs your eval config, gates on a pass-rate threshold, compares against a committed baseline, and generates a Markdown report suitable for PR comments.

## Install

```bash
npm install --save-dev @eidentic/eval
```

## Define an eval

An eval config exports `runner`, `dataset`, and `scorers`:

```ts
// eval/support-eval.ts
import { createRunner, llmJudge, evaluate } from "@eidentic/eval";
import { agent } from "../src/agent.js";

export const runner = createRunner(async (input: string) => {
  const chunks: string[] = [];
  for await (const ev of agent.query(input, { sessionId: crypto.randomUUID() })) {
    if (ev.type === "text_delta") chunks.push(ev.delta);
  }
  return chunks.join("");
});

export const dataset = [
  { id: "greeting", input: "Hello!", expectedOutput: "Hi" },
  { id: "refund",   input: "I want a refund", expectedOutput: "refund policy" },
];

export const scorers = [
  llmJudge({
    model,
    criteria: "Does the response address the user's request helpfully?",
  }),
];
```

## CLI flags

```bash
npx eidentic eval eval/support-eval.ts \
  --ci \
  --threshold 0.8 \
  --baseline .eidentic/eval-baseline.json \
  --report eval-report.md
```

| Flag | Description |
|---|---|
| `--ci` | Exit non-zero on threshold violation or regression |
| `--threshold <0–1>` | Minimum acceptable aggregate pass rate |
| `--baseline <path>` | Compare against a committed baseline snapshot; fails the job on regression |
| `--report <path>` | Write a Markdown report (GitHub-comment-ready) |
| `--save-baseline <path>` | Write the current run as the new baseline snapshot |

## `compareReports` — programmatic regression detection

```ts
import { compareReports, type CompareResult } from "@eidentic/eval";

const result: CompareResult = compareReports(currentReport, baselineReport, {
  tolerance: 0.05, // allow up to 5 % regression before flagging
});

if (result.regressions.length > 0) {
  console.error("Regressions:", result.regressions);
  process.exit(1);
}
```

`CompareResult.regressions` is `RegressionEntry[]` (case + scorer + delta); `improvements` is the opposite.

## `assertPassRate` — gate in your own test runner

```ts
import { evaluate, assertPassRate, summarize } from "@eidentic/eval";

const report = await evaluate({ runner, dataset, scorers });
console.log(summarize(report));
assertPassRate(report, 0.8); // throws EvalThresholdError if below 80 %
```

`EvalThresholdError` carries `actualPassRate`, `requiredPassRate`, and `failedCases` (per-case pass rates).

## Baseline workflow

```bash
# Generate initial baseline (commit this file)
npx eidentic eval eval/support-eval.ts --save-baseline .eidentic/eval-baseline.json
git add .eidentic/eval-baseline.json
git commit -m "chore: add eval baseline"

# On every PR: run against the baseline
npx eidentic eval eval/support-eval.ts --ci --threshold 0.8 --baseline .eidentic/eval-baseline.json
```

## GitHub Actions workflow

Drop this file into `.github/workflows/eval.yml` in your repo:

```yaml
name: Eval

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

env:
  EVAL_CONFIG: eval/my-eval.ts
  PASS_THRESHOLD: "0.8"
  BASELINE_PATH: .eidentic/eval-baseline.json

jobs:
  eval:
    name: Run evals
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: pnpm

      - name: Install pnpm
        uses: pnpm/action-setup@v3
        with:
          version: latest

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run eidentic eval
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx eidentic eval "$EVAL_CONFIG" \
            --ci \
            --threshold "$PASS_THRESHOLD" \
            --baseline "$BASELINE_PATH" \
            --report eval-report.md

      - name: Post eval report as PR comment
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const fs = require('fs');
            const reportPath = 'eval-report.md';
            if (!fs.existsSync(reportPath)) return;
            const body = fs.readFileSync(reportPath, 'utf8');
            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const MARKER = '<!-- eidentic-eval-report -->';
            const comments = await github.rest.issues.listComments({ owner, repo, issue_number });
            const existing = comments.data.find(c => c.body && c.body.includes(MARKER));
            if (existing) {
              await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
            } else {
              await github.rest.issues.createComment({ owner, repo, issue_number, body });
            }

      - name: Upload eval report artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report
          path: eval-report.md
          if-no-files-found: ignore
```

The report uses a `<!-- eidentic-eval-report -->` marker so the PR comment is updated idempotently — no duplicate comments on repeated pushes.

## Key API types

| Symbol | Package | Description |
|---|---|---|
| `evaluate` | `@eidentic/eval` | Run the full eval; returns `EvalReport` |
| `assertPassRate` | `@eidentic/eval` | Gate: throws `EvalThresholdError` below threshold |
| `compareReports` | `@eidentic/eval` | Diff two reports; returns `CompareResult` |
| `renderReportMarkdown` | `@eidentic/eval` | Generate GitHub-comment-ready Markdown |
| `llmJudge` | `@eidentic/eval` | Model-based scorer; configurable criteria |
| `trajectory` | `@eidentic/eval` | Deterministic scorer: tool names, call order |
| `createRunner` | `@eidentic/eval` | Wrap any async function as an eval runner |
| `captureFailure` | `@eidentic/eval` | Promote a production failure to a dataset case |

## Gotchas

- `--ci` without `--baseline` still gates on `--threshold` but skips regression comparison.
- Baseline snapshots contain pass rates per (case, scorer) pair. Move the `--save-baseline` flag to a separate step that only runs on pushes to `main` to avoid overwriting the baseline with a regressed run.
- `llmJudge` calls your provider for scoring — factor those calls into your CI budget.
