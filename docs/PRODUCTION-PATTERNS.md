# Production Patterns

This page collects the v1 launch-path patterns that usually matter before a team exposes an agent to real users.

## Fresh Install Smoke

Use the no-key testing subpath to prove install, imports, model execution, and event streaming without creating a provider account:

```bash
npm init -y
npm install eidentic
```

```ts
import { Agent, textBlock } from "eidentic";
import { InMemoryStore, MockModel } from "eidentic/testing";

const store = new InMemoryStore();
await store.migrate();

const agent = new Agent({
  id: "smoke",
  instructions: "Reply once.",
  model: new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
  store,
});

for await (const ev of agent.query("hello", { sessionId: "s1" })) {
  if (ev.type === "result") console.log(ev.output);
}
```

`eidentic/testing` is for local smoke tests, examples, and adapter conformance. Production code should use a real `ModelPort` and persistent store.

For a repeatable outside-the-monorepo check:

```bash
node scripts/fresh-install-smoke.mjs --package eidentic
```

During release testing you can pass a packed tarball instead of the npm name:

```bash
node scripts/fresh-install-smoke.mjs --package ./eidentic-1.0.0.tgz
```

## Single Gateway

Eidentic does not construct providers internally. Model calls, embedding calls, guardrails, strategies, judges, and memory consolidation all cross `ModelPort` or `EmbeddingPort`. To force traffic through one OpenAI-compatible gateway such as LiteLLM, OpenRouter, vLLM, or a private proxy, build the AI SDK provider once and pass it everywhere:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { Agent, AIEmbedder, AIModel, Memory, SqliteStore } from "eidentic";

const gateway = createOpenAI({
  baseURL: process.env.AI_GATEWAY_BASE_URL!,
  apiKey: process.env.AI_GATEWAY_API_KEY!,
});

const store = new SqliteStore("./eidentic.sqlite");
await store.migrate();

const model = new AIModel(gateway(process.env.AI_GATEWAY_CHAT_MODEL ?? "gpt-4o-mini"));
const embedder = await AIEmbedder.create(
  gateway.embedding(process.env.AI_GATEWAY_EMBED_MODEL ?? "text-embedding-3-small"),
);

const memory = new Memory({ store, embedder });

const agent = new Agent({
  id: "support",
  instructions: "Help the user.",
  model,
  store,
  memory,
});
```

Keep provider keys in the gateway. The app should hold only the gateway key.

## Custom Store Adapter

Implement `StorePort` when you want Eidentic to use your application database as the event, memory, and session store.

Minimum viable adapter:

- `migrate`, `createSession`, `getSession`, `appendEvents`, `readEvents`
- block methods: `getBlocks`, `getBlock`, `upsertBlock`, `appendBlock`, `getBlockHistory`
- memory index methods: `indexMemory`, `searchMemory`
- erasure: `eraseScope`

Use the conformance suite before trusting the adapter:

```ts
import { describe, it } from "vitest";
import { storeConformanceCases } from "eidentic/testing";
import { MyStore } from "./my-store";

describe("MyStore conformance", () => {
  for (const c of storeConformanceCases(() => new MyStore())) {
    it(c.name, async () => c.run());
  }
});
```

If the underlying database has no full-text search, implement a conservative lexical fallback in `searchMemory` rather than returning every row. The in-memory test store is a small reference implementation.

## Durable HITL Suspend/Resume

Human-in-the-loop approval is a durable tool behavior. A tool can call `ctx.suspend()`, the run terminates with `subtype: "suspended"`, and a later `agent.resume(sessionId, { decision })` continues the same session.

```ts
const approveRefund = createTool({
  id: "approve_refund",
  description: "Request approval before issuing a refund.",
  sideEffect: "destructive",
  inputSchema: z.object({ amountUsd: z.number().positive() }),
  idempotencyKey: (input) => `refund:${input.amountUsd}`,
  execute: async ({ input, ctx }) => {
    const decision = await ctx.suspend?.({
      reason: "refund approval",
      present: { amountUsd: input.amountUsd },
    });
    if (decision !== "approve") return { approved: false };
    return issueRefund(input.amountUsd);
  },
});
```

For approvals that may last hours or days, use a persistent durable store such as SQLite on a durable disk, libSQL, Postgres, or Convex. In-memory stores are only for tests and demos.

## better-auth Permission Bridge

`@eidentic/better-auth` maps a better-auth session to an Eidentic principal. Use `permissionsFor` when permissions depend on the authenticated user, organization, or API key.

```ts
const agent = new Agent({
  id: "support",
  instructions: "Help the user.",
  model,
  store,
  permissionsFor: (principal) => {
    if (principal.orgId === "ops") return { mode: "auto" };
    return { mode: "deny", deny: ["send_email", "write_file", "bash"] };
  },
});

const app = createServer({
  agents: { support: agent },
  auth: betterAuthPort(auth),
});
```

Permission checks run in code at dispatch time. The model prompt is not a security boundary.

## Org Tenancy

Eidentic distinguishes actor identity from memory scope:

- `principal.userId`, `principal.orgId`, and `principal.apiKey` identify the caller for auth, session ownership, rate limits, quota, and audit correlation.
- `memoryScope` chooses where memory reads and writes go: agent, user, thread, org, or shared.

Use user scope for personal preferences and org scope for institutional knowledge:

```ts
await agent.query("Remember our refund policy changed.", {
  sessionId: "s1",
  principal: { userId: "u1", orgId: "acme" },
  memoryScope: { kind: "org", agentId: "support", orgId: "acme" },
});
```

Server mode enforces session ownership from the authenticated principal. Store and vector adapters are scope-keyed, so cross-tenant leaks should be caught by adapter conformance tests.

## Audit Sink

Wire the same `onAuditEvent` sink to `Agent` and `createServer` to get one structured stream for executed tools, permission denials, erasure, auth failures, quota failures, and rate-limit failures:

```ts
const audit = (event: AuditEvent) => {
  auditLog.write({
    ...event,
    receivedAt: Date.now(),
  });
};

const agent = new Agent({ id: "support", instructions, model, store, onAuditEvent: audit });
const app = createServer({ agents: { support: agent }, auth, quota, rateLimiter, onAuditEvent: audit });
```

Audit events intentionally avoid tool inputs, tool outputs, prompts, request bodies, and secrets. Join to traces or app records by `sessionId`, `scopeKey`, `principalId`, and route.
