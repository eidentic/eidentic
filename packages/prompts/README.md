# @eidentic/prompts

Immutable prompt versioning for Eidentic agents — register, tag, canary-split, and
rollback agent instructions as first-class versioned artifacts.

Treating prompts as immutable versioned artifacts (rather than mutable config strings)
is the 2026 production standard. Every change gets a new version, every deploy is a tag
move, and every rollback is another tag move — all audit-logged.

## Install

```bash
pnpm add @eidentic/prompts
```

## Core concepts

| Concept | Description |
|---|---|
| **Version** | Immutable snapshot of a prompt body. Auto-increments. Identical body = no-op (dedup by SHA-256). |
| **Tag** | Named pointer to a version (`"stable"`, `"candidate"`, …). Moving a tag = deploy or rollback. |
| **Canary** | Deterministic traffic split by key (session/user ID). No server-side state needed. |
| **History** | Append-only audit log of every version registration and tag move. |

## Quick start

```ts
import { createPromptRegistry, filePromptStore, renderPrompt } from "@eidentic/prompts";

const registry = createPromptRegistry(filePromptStore("./data/prompts.json"));

// Register versions (identical body = no-op)
const v1 = await registry.register("support-agent-system", "You are a helpful assistant.");
const v2 = await registry.register("support-agent-system", "You are a concise, helpful assistant.");

// Deploy v2 as stable
await registry.tag("support-agent-system", 2, "stable");

// Resolve the stable prompt per request
const prompt = await registry.get("support-agent-system", "stable");
```

## Rollback

Moving the `"stable"` tag to an earlier version IS a rollback:

```ts
await registry.tag("support-agent-system", 1, "stable"); // instant rollback
```

Every tag move is recorded in the history log.

## Canary splits

Route a fraction of traffic to a candidate prompt, deterministically by key:

```ts
const { body, version, arm } = await registry.canary("support-agent-system", {
  stable: "stable",
  candidate: "candidate",
  fraction: 0.1,      // 10 % → candidate
  key: sessionId,     // same key always → same arm
});

const agent = createAgent({ instructions: body });
// Record arm in eval metadata for offline A/B analysis:
await evalStore.log({ sessionId, promptArm: arm, promptVersion: version });
```

## renderPrompt

Interpolate `{{variable}}` placeholders. Throws on missing variables:

```ts
const instructions = renderPrompt(
  "You are a {{role}} assistant. Today is {{date}}.",
  { role: "helpful", date: new Date().toISOString() },
);
```

## Audit history

```ts
const events = await registry.history("support-agent-system");
// [
//   { kind: "version_registered", version: 1, hash: "…", createdAt: "…" },
//   { kind: "version_registered", version: 2, hash: "…", createdAt: "…" },
//   { kind: "tag_moved", tag: "stable", fromVersion: null, toVersion: 2, createdAt: "…" },
//   { kind: "tag_moved", tag: "stable", fromVersion: 2, toVersion: 1, createdAt: "…" }, // rollback
// ]
```

## Stores

| Store | Usage |
|---|---|
| In-memory (default) | `createPromptRegistry()` — process lifetime only, ideal for tests |
| File store | `createPromptRegistry(filePromptStore("./prompts.json"))` — crash-safe atomic writes |
| Custom | Implement `PromptStore` (`load() / save(state)`) for any backend |

## API reference

### `createPromptRegistry(store?)`

Returns a `PromptRegistry` with:

- `register(name, body, { tags?, meta? })` → `Promise<PromptVersion>`
- `get(name, ref?)` → `Promise<PromptVersion>` — ref: version number | tag | undefined (latest)
- `tag(name, version, tag)` → `Promise<void>`
- `untag(name, tag)` → `Promise<void>`
- `history(name)` → `Promise<HistoryEvent[]>`
- `canary(name, { stable, candidate, fraction, key })` → `Promise<CanaryResult>`

### `renderPrompt(body, vars)`

Substitutes `{{varName}}` placeholders. Throws `PromptRenderError` listing all missing variables.

### `filePromptStore(path)`

Crash-safe JSON file store. Each write is a full snapshot atomically `rename`d over the target.
