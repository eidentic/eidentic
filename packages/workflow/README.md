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
import { step, chain, parallel, retry } from "@eidentic/workflow";

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
const result = await pipeline({ url: "https://example.com/api" }, { traces: [] });
console.log(result); // { result: 42 }

// Parallel fan-out
const tasks = parallel([fetchData, fetchData]);
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
