# @eidentic/eval

Evaluation harness for Eidentic agents — define scorers, run LLM-as-judge evaluations,
manage JSONL datasets, enforce a CI pass-rate gate, and promote production traces into
regression tests with a single call. Every incident becomes a test.

## Install

```bash
pnpm add @eidentic/eval
```

## Usage

```ts
import { evaluate, createRunner, assertPassRate, promoteTraceToEvalCase } from "@eidentic/eval";
import { trajectory } from "@eidentic/eval";

// Create a runner that drives the agent and captures events
const runner = createRunner(agent, store);

const report = await evaluate(
  runner,
  myDataset,
  { scorers: [trajectory.toolCorrectness], samples: 1 },
);

// CI gate — throws EvalThresholdError if pass rate < threshold
assertPassRate(report, 0.8);

// Promote a production session's stored events to an eval case
import type { StoredEvent } from "@eidentic/types";
const events: StoredEvent[] = await store.readEvents("prod-session-42");
const evalCase = promoteTraceToEvalCase(events, { tags: { type: "bug-repro" } });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
