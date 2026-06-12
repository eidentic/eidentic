# @eidentic/convex

A [Convex](https://www.convex.dev)-backed store adapter for [Eidentic](https://github.com/eidentic/eidentic).

`ConvexStore` implements **`StorePort` + `GraphPort` + `DurablePort`** (sessions, the append-only
event log, always-in-context memory blocks with CAS, the lexical memory index, the temporal
knowledge graph, **and durable execution** — checkpoints, an exactly-once idempotency ledger, and
human-in-the-loop suspension decisions). `ConvexVectorStore` implements **`VectorPort`**
(cosine-ranked vector search). All come from `@eidentic/types`.

Convex's serializable mutations make the durable ledger atomic by construction: every
checkpoint/intent/completion/decision write is a single transaction, so checkpoint-resume and
exactly-once tool dispatch hold under concurrency without extra locking.

The agent runtime runs **outside** Convex and talks to a deployment through an injectable runner.
This is the *app-functions* model — you re-export a handful of Convex functions from your own
`convex/` directory and spread the adapter's tables into your schema. It is **not** a Convex
Component.

## Install

```bash
npm i @eidentic/convex convex
# convex is a peer dependency
```

## Two-step setup

### 1. Spread the tables into your schema

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { eidenticTables } from "@eidentic/convex/schema";

export default defineSchema({
  ...eidenticTables,
  // ...your own tables
});
```

`eidenticTables` defines `sessions`, `events`, `blocks`, `blockHistory`, `memories`, `facts`, and
`vectors` with the indexes the adapter queries.

### 2. Re-export the function handlers

```ts
// convex/eidentic.ts
export * from "@eidentic/convex/server";
```

The handlers are built with Convex's generic builders (`queryGeneric` / `mutationGeneric`) typed
over the eidentic schema, so they do **not** depend on your app's `_generated` codegen. The module
name (`eidentic`) determines the function paths (`eidentic:appendEvents`, …).

Run `npx convex dev` (or `codegen`) as usual so Convex picks up the new tables and functions.

### 3. Build the runner and the store

```ts
import { ConvexHttpClient } from "convex/browser";
import { ConvexStore, ConvexVectorStore, convexHttpRunner } from "@eidentic/convex";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);
const runner = convexHttpRunner(client);

const store = new ConvexStore(runner);          // StorePort, GraphPort & DurablePort
const vectors = new ConvexVectorStore(runner);  // VectorPort
```

`convexHttpRunner` defaults the function references to the `eidentic:*` string paths produced by
`defaultStoreFns()` / `defaultVectorFns()`. If you re-exported the handlers from a module other
than `convex/eidentic.ts`, pass custom refs:

```ts
import { defaultStoreFns } from "@eidentic/convex";
const store = new ConvexStore(runner, { fns: defaultStoreFns("memory") }); // convex/memory.ts
```

You can also pass codegen `api.eidentic.appendEvents` references or `anyApi` refs directly via the
`fns` option — any value `ConvexHttpClient` accepts as a function reference works.

## Quickstart

```ts
const scope = { kind: "user", agentId: "support-bot", userId: "u_42" } as const;

await store.createSession({ id: "s1", agentId: "support-bot", createdAt: new Date().toISOString() });
await store.appendEvents([
  { id: "e0", sessionId: "s1", seq: 0, kind: "user", schemaVersion: 1, payload: "hi", createdAt: "..." },
]);

await store.upsertBlock(scope, { label: "profile", value: "Name: Ada" });
await store.indexMemory([{ scope, id: "m1", text: "Ada prefers email over phone" }]);
const hits = await store.searchMemory(scope, "email", 5);

// Temporal knowledge graph
await store.assertFact(scope, { subject: "Ada", predicate: "lives_in", object: "Paris" });
const facts = await store.queryFacts({ scope, subject: "Ada" });
```

## Notes

- **`migrate()` and `close()` are no-ops.** Convex owns the schema (managed via `convex dev`), and
  there is no client connection to tear down.
- **Atomicity.** A single Convex mutation is one transaction, so multi-row writes
  (`appendEvents`, `upsertBlock` + history, `indexMemory` delete-then-insert, `assertFact`
  invalidate + insert, `eraseScope`) commit or roll back together. `appendEvents` checks **all**
  conflicts (duplicate id, duplicate `(sessionId, seq)`, intra-batch duplicates) **before** any
  insert and throws a `StoreConflictError` so the whole batch rolls back.
- **Search is computed in the handler, not by native indexes.** Both lexical (`searchMemory`) and
  vector (`vectorSearch`) ranking read the scope's rows via the scope index and score in JS (TF for
  lexical, cosine for vectors). This is deterministic and fully testable under `convex-test`.
  Convex's native `searchIndex` / `vectorIndex` are a **future performance optimization** — they
  are not used today.

## Testing

The package's own conformance tests use [`convex-test`](https://github.com/get-convex/convex-test)
with the `edge-runtime` Vitest environment — no `convex dev` login required. The same injectable
runner wraps a `convexTest(schema, modules)` instance, and the shared `storeConformanceCases` /
`vectorConformanceCases` from `@eidentic/types/testing` run against it.

## License

Apache-2.0
