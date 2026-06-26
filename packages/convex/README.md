# @eidentic/convex

A [Convex](https://www.convex.dev)-backed adapter for [Eidentic](https://github.com/eidentic/eidentic).

Recommended path: install Eidentic as a **Convex Component** so Eidentic's sessions, events,
memory, graph, vector, checkpoint, idempotency, and decision tables live inside an isolated component
schema instead of being spread into your host app schema.

The older app-functions/HTTP runner path is still supported for external workers and server
processes. Existing `@eidentic/convex`, `@eidentic/convex/schema`, and `@eidentic/convex/server`
imports continue to work.

## Install

```bash
npm i @eidentic/convex convex
```

`convex` is a peer dependency.

## Component Setup

Add the component to `convex/convex.config.ts`:

```ts
import { defineApp } from "convex/server";
import eidentic from "@eidentic/convex/convex.config.js";

const app = defineApp();

app.use(eidentic, { name: "eidentic" });

export default app;
```

Run Convex codegen as usual:

```bash
npx convex dev
```

Use the component from a host action or mutation after your app has authenticated the caller and
resolved workspace/org/business context:

```ts
import { components } from "./_generated/api";
import { action } from "./_generated/server";
import { EidenticComponentStore, EidenticComponentVectorStore } from "@eidentic/convex/component";

export const runAgent = action({
  args: {},
  handler: async (ctx) => {
    const store = new EidenticComponentStore(ctx, components.eidentic);
    const vectors = new EidenticComponentVectorStore(ctx, components.eidentic);

    await store.upsertBlock(
      { kind: "agent", agentId: "support-bot" },
      { label: "profile", value: "Name: Ada" },
    );

    return await vectors.list("agent:support-bot");
  },
});
```

Component tables use singular snake_case names internally:

```txt
session, event, block, block_history, memory, fact, vector,
checkpoint, idempotency, decision
```

Those tables are owned by the component and do not appear in the host app's schema.

## Security Model

Do not expose component functions directly as your product API. Route client calls through host app
functions such as `api.ai.eidentic.draftReply`, authenticate there, check workspace/org/role
permissions, assemble business context, and then call the component.

This keeps Eidentic focused on durable agent runtime state while your app remains the authority for
users, tenants, model credentials, and final side effects.

## App-Functions Path

Use app-functions when the Eidentic runtime runs outside Convex and talks to a deployment through
`ConvexHttpClient`.

### Legacy schema spread

This is unchanged and remains source-compatible:

```ts
import { defineSchema } from "convex/server";
import { eidenticTables } from "@eidentic/convex/schema";

export default defineSchema({
  ...eidenticTables,
});
```

### Prefixed app-functions schema

For new app-functions installs, prefer prefixed table names:

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { createEidenticTableNames, createEidenticTables } from "@eidentic/convex/app-functions/schema";

export const eidenticTableNames = createEidenticTableNames({ prefix: "eidentic_" });

export default defineSchema({
  ...createEidenticTables({ names: eidenticTableNames }),
});
```

Register handlers with the same table map:

```ts
// convex/eidentic.ts
import { eidenticFunctions, type EidenticAuthorize } from "@eidentic/convex/app-functions/server";
import { eidenticTableNames } from "./schema.js";

const authorize: EidenticAuthorize = async (ctx, { op, args }) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("unauthenticated");

  const sessionId = args["sessionId"];
  if (typeof sessionId === "string" && !sessionId.startsWith(identity.subject)) {
    throw new Error(`forbidden: ${op}`);
  }
};

export const {
  createSession, getSession, listSessions, appendEvents, readEvents,
  getBlocks, getBlock, upsertBlock, appendBlock, getBlockHistory, listBlocks,
  indexMemory, searchMemory, assertFact, queryFacts, corroborate, expireFacts,
  sweepExpired, eraseScope, writeCheckpoint, lastCheckpoint, recordIntent,
  recordCompletion, getIdempotency, recordDecision, getDecision,
  vectorUpsert, vectorSearch, vectorDelete, vectorEraseScope, vectorList,
} = eidenticFunctions({
  tables: eidenticTableNames,
  authorize,
});
```

The bare `export * from "@eidentic/convex/server"` path is still supported, but treat it as
legacy/trusted-only. In multi-tenant products, use `eidenticFunctions({ authorize })`.

### HTTP runner

```ts
import { ConvexHttpClient } from "convex/browser";
import { ConvexStore, ConvexVectorStore, convexHttpRunner } from "@eidentic/convex";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);
client.setAuth(process.env.CONVEX_AUTH_TOKEN!);

const runner = convexHttpRunner(client);
const store = new ConvexStore(runner);
const vectors = new ConvexVectorStore(runner);
```

## Durable Idempotency Metadata

`recordIntent`, `recordCompletion`, and `getIdempotency` accept optional ownership metadata:

```ts
await store.recordIntent("sess1:send_email:a@test.com", "args-hash", {
  sessionId: "sess1",
  ownerKey: "user:u1",
});
```

This gives Convex authorization hooks structured fields to check instead of parsing opaque keys.
Eidentic core passes `sessionId` automatically for durable tool dispatch.

## Vector Strategy

`ConvexVectorStore` remains a zero-infra vector adapter that stores vectors in Convex and scores
with deterministic JS cosine ranking. It is suitable for demos, tests, and small deployments.

For production semantic memory at scale, prefer an external `VectorPort` such as
`@eidentic/qdrant` and keep a separate collection for Eidentic memory.

## Migration Notes

- Existing app-functions installs can upgrade without code changes.
- New Convex apps should use the component path.
- Existing app-functions installs that want prefixed table names need a data migration or a fresh
  Convex deployment; changing table names is not automatic.
- The bare public handler re-export remains available for compatibility, but multi-tenant apps
  should migrate to `eidenticFunctions({ authorize })` or to the component path.

## Testing

This package is covered by Convex store/vector/durable conformance tests via `convex-test`, plus
tests for table-name factories, authorization metadata, and in-process runners.

## License

Apache-2.0
