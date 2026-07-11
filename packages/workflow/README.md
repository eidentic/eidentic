# @eidentic/workflow

Durable workflow orchestration for Eidentic — composable `step` primitives, parallel
execution, fan-out/fan-in, retries with back-off, branching, timeouts, an agent-step
adapter, and a persistent `WorkflowRunRegistry` for tracking run history. Used by
`@eidentic/server` to expose workflow runs over HTTP.

## Install

```bash
pnpm add @eidentic/workflow
```

## Usage

```ts
import {
  step,
  chain,
  parallel,
  retry,
  fileWorkflowRunStore,
} from "@eidentic/workflow";

// Define steps as typed async functions
const fetchData = step(
  "fetch-data",
  async (input: { url: string }) => {
    const res = await fetch(input.url);
    return res.json() as unknown;
  },
);

const processData = step(
  "process-data",
  async (data: unknown) => ({ result: JSON.stringify(data).length }),
);

// Compose with chain, retry, parallel
const pipeline = chain(
  retry(fetchData, { maxAttempts: 3 }),
  processData,
);

// Run the pipeline
const ctx = { emit: () => undefined, path: [] };
const result = await pipeline({ url: "https://example.com/api" }, ctx);
console.log(result); // { result: 42 }

// Parallel fan-out
const tasks = parallel({ primary: fetchData, secondary: fetchData });

// Durable run history
const runStore = fileWorkflowRunStore("./data/workflow-runs.json");
```

Numeric execution options fail fast unless they are positive safe integers. This applies to map
concurrency, retry attempts/backoff, step timeouts, registry limits, and resume leases. Omit
`backoffMs` to retry without a delay.

The file-backed run store writes `0600` snapshots through random `O_EXCL` temporary files, fsyncs
before and after atomic rename, serializes independent processes with an owner-only lock, and
refuses caller-writable symlink leaves or parent components.

Suspended-run replay uses a single-owner lease. The runner renews the lease while work is active
and validates the claim immediately before every uncached `ctx.step` effect; expired or superseded
claims fail closed. Keep external side effects inside `ctx.step`, make them idempotent, and pass a
downstream fencing/idempotency token when the external system supports one: JavaScript cannot undo
an effect from step code that ignores cancellation after its lease is lost.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
