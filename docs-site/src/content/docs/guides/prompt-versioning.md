---
title: Prompt Versioning
description: "@eidentic/prompts — registry, named tags as deploy/rollback, canary traffic splitting, filePromptStore."
---

`@eidentic/prompts` gives every prompt body an immutable version number, named deployment tags, and deterministic canary splitting — with no external database required.

## Install

```bash
npm install @eidentic/prompts
```

## Basics

```ts
import { createPromptRegistry, filePromptStore } from "@eidentic/prompts";

const registry = createPromptRegistry(
  filePromptStore("./data/prompts.json") // crash-safe atomic-rename JSON
);

// Register a version (idempotent — same body → same version returned)
const v1 = await registry.register(
  "support-system",
  "You are a helpful support agent. Today is {{date}}.",
  { tags: { env: "prod" }, meta: { ticket: "PROD-42" } }
);
console.log(v1.version); // 1

// Change the body → new version
const v2 = await registry.register("support-system", "You are an expert support agent.");
console.log(v2.version); // 2
```

## Named deployment tags

Tags act as mutable pointers to immutable version numbers. Moving the `"stable"` tag backward IS a rollback.

```ts
// Tag version 2 as the live "stable" prompt
await registry.tag("support-system", 2, "stable");

// Get the current stable prompt
const prompt = await registry.get("support-system", "stable");

// Rollback: move stable back to v1
await registry.tag("support-system", 1, "stable");

// Remove a tag
await registry.untag("support-system", "candidate");
```

`registry.history("support-system")` returns every `version_registered`, `tag_moved`, and `tag_removed` event, oldest-first — full audit trail.

## Using a versioned prompt with an agent

```ts
import { renderPrompt } from "@eidentic/prompts";

async function handleQuery(sessionId: string, userMessage: string) {
  const prompt = await registry.get("support-system", "stable");
  const instructions = renderPrompt(prompt.body, { date: new Date().toISOString() });

  const agent = new Agent({ instructions, model, store, id: "support" });

  for await (const ev of agent.query(userMessage, { sessionId })) {
    // …
  }
}
```

`renderPrompt` substitutes `{{variable}}` placeholders. `PromptRenderError` is thrown for missing variables.

## Canary traffic splitting

Deterministic splitting routes a stable fraction of sessions to a candidate prompt without any server-side state. The same key always resolves to the same arm for a given fraction.

```ts
const { body, version, arm } = await registry.canary("support-system", {
  stable: "stable",        // tag or version number
  candidate: "candidate",
  fraction: 0.10,          // 10 % → candidate, 90 % → stable
  key: sessionId,          // deterministic routing key
});

const agent = new Agent({ instructions: body, model, store, id: "support" });

// Record arm in your eval metadata for offline comparison
await evalStore.log({ sessionId, promptArm: arm, promptVersion: version });
```

`arm` is `"stable"` or `"candidate"`. `fraction: 0` sends all traffic to stable; `fraction: 1` sends all to candidate.

## `PromptVersion` shape

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Logical prompt name |
| `version` | `number` | Monotonically incrementing integer starting at 1 |
| `hash` | `string` | SHA-256 hex digest of the body (dedup key) |
| `body` | `string` | Raw prompt text |
| `createdAt` | `string` | ISO-8601 registration timestamp |
| `tags` | `Record<string, string>` | Arbitrary key/value tags (e.g. `{ env: "prod" }`) |
| `meta` | `Record<string, unknown>` | Caller metadata (ticket, owner, model, …) |

## Stores

| Store | When to use |
|---|---|
| `memoryPromptStore()` | Default (no args to `createPromptRegistry()`). Tests and scripts. |
| `filePromptStore(path)` | Production servers. Crash-safe: writes to `<path>.tmp` then renames atomically. |

Implement `PromptStore` (`load()` / `save()`) to back versions with a database.

## Gotchas

- Body content is immutable — once registered, a version's body never changes. Edit the body and call `register` again to get a new version number.
- `register` is idempotent: the same body under the same name always returns the existing version. This makes startup calls safe.
- All mutating operations (`register`, `tag`, `untag`) are serialized internally — concurrent calls are safe.
- `renderPrompt` throws `PromptRenderError` if a `{{placeholder}}` in the body has no matching variable. Guard with try/catch or ensure all placeholders are populated.
