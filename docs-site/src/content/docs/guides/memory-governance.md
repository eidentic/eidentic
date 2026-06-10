---
title: Memory Governance
description: State-transition timelines, corroboration tiers, consent enforcement, portable export, and identity merge.
---

The memory governance layer sits on top of the core `Memory` class and gives you precise control over the full lifecycle of stored knowledge: how facts evolve over time, when they become stale, which categories of personal data may be retained, how to export data portably, and how to merge scopes when a user authenticates.

All APIs documented here require a `graph` backend in your `Memory` instance.

```ts
import { Memory } from "@eidentic/memory";
import { SqliteStore } from "eidentic";

const memory = new Memory({ store: new SqliteStore("./eidentic.sqlite"), graph: store });
```

---

## State-transition timelines

Facts are versioned, not replaced. Every time you assert a new value for a `(subject, predicate)` pair, the prior fact gets its `validUntil` set to the new `validFrom` — the old fact is **invalidated**, not deleted. This preserves a full audit trail of what was known at every point in time.

```ts
// Assert initial city
await memory.assertFact(scope, {
  subject: "alice",
  predicate: "city",
  object: "New York",
  validFrom: "2024-01-01T00:00:00.000Z",
});

// Alice moves — invalidates the NY fact automatically
const { asserted, invalidated } = await memory.assertFact(scope, {
  subject: "alice",
  predicate: "city",
  object: "San Francisco",
  validFrom: "2025-06-01T00:00:00.000Z",
});
// asserted.object === "San Francisco"
// invalidated[0]?.object === "New York"  (validUntil set to 2025-06-01)
```

The `asserted` fact carries a `supersedes` field — the `id` of the fact it replaced. This lets you follow the chain explicitly.

### Full timeline

`memory.factTimeline(scope, subject, predicate)` returns every version ever asserted (valid and invalidated), ordered ascending by `validFrom`:

```ts
const timeline = await memory.factTimeline(scope, "alice", "city");
// [
//   { object: "New York",      validFrom: "2024-01-01", validUntil: "2025-06-01", supersedes: undefined },
//   { object: "San Francisco", validFrom: "2025-06-01", validUntil: undefined,    supersedes: "<ny-fact-id>" },
// ]
```

### Point-in-time queries

Pass `validAt` to `queryFacts` to ask "what was the value at a specific moment?" — this is the foundation of the temporal benchmark:

```ts
const pastFacts = await memory.queryFacts({
  scope,
  subject: "alice",
  predicate: "city",
  validAt: "2024-07-01T00:00:00.000Z", // mid-2024 — should return "New York"
});
// pastFacts[0]?.object === "New York"
```

Omitting `validAt` returns only currently-valid facts (`validUntil IS NULL`).

---

## Corroboration and staleness tiers

High-traffic facts can become confidently wrong if they are never re-confirmed. Corroboration tiers let you flag facts that haven't been re-observed within a configurable window without dropping them.

### Configuring the window

Pass `corroborationTtlMs` to `Memory` — a single number for a global window, or a per-predicate record:

```ts
const memory = new Memory({
  store,
  graph: store,
  // Global: flag anything not re-confirmed in 90 days
  corroborationTtlMs: 90 * 24 * 60 * 60 * 1000,
});

// — or per predicate —
const memory = new Memory({
  store,
  graph: store,
  corroborationTtlMs: {
    works_at:  90 * 24 * 60 * 60 * 1000,  // 90 days
    lives_in: 180 * 24 * 60 * 60 * 1000,  // 180 days
    __default: 365 * 24 * 60 * 60 * 1000, // 1 year for anything else
  },
});
```

### Stale flag and snippet annotation

When `retrieve()` returns a snippet for a fact past its corroboration deadline, two things happen:

1. The snippet carries `stale: true`.
2. The snippet text is annotated: `"alice city San Francisco (last confirmed >30d ago — may be outdated)"`.

The fact is **never dropped** — only flagged. Your agent sees the freshness caveat in context and can decide how to act.

```ts
const { snippets } = await memory.retrieve({ text: "where does alice live?", scope });
for (const s of snippets) {
  if (s.stale) console.warn("stale:", s.text);
}
```

### Re-confirming a fact

Call `memory.corroborate` whenever you observe that a fact is still true. It bumps `lastCorroboratedAt` without creating a new fact row:

```ts
const bumped = await memory.corroborate(scope, factId);
// bumped === 1 if the fact exists and is currently valid; 0 otherwise
```

Pass an explicit epoch-ms timestamp to backdate the confirmation:

```ts
await memory.corroborate(scope, factId, Date.now() - 3600_000); // "re-confirmed 1 h ago"
```

### Options table

| Option | Type | Default | What it controls |
|---|---|---|---|
| `corroborationTtlMs` | `number \| Record<string, number>` | `undefined` (off) | Staleness window per predicate or globally. `__default` key applies to unlisted predicates. |

---

## Consent enforcement

The consent manifest governs which categories of personal data the memory system may retain and for how long. Enforcement happens at **write time** (reject or TTL) and can be applied **retroactively** via `applyConsent`.

### Write-time enforcement

```ts
import { Memory } from "@eidentic/memory";

const memory = new Memory({
  store,
  graph: store,
  consent: {
    categories: {
      health:       "never",    // health data: never persist
      location:     "session",  // location: keep for one session (30 min default)
      "contact-info": 7 * 24 * 60 * 60 * 1000, // contact info: keep for 7 days
    },
  },
});
```

The built-in `defaultConsentClassifier` (from `@eidentic/types`) maps text to three categories:
- `health` — medical conditions, diagnoses, medications, mental-health terms
- `location` — residence statements, addresses, lat/long coordinates
- `contact-info` — email addresses, phone numbers

Supply a custom `classify` function to override or extend:

```ts
consent: {
  categories: { pii: "never", preferences: 30 * 24 * 60 * 60 * 1000 },
  classify: (text, fact) => {
    if (fact?.predicate === "credit_card") return "pii";
    if (text.includes("prefers") || text.includes("likes")) return "preferences";
    return undefined; // unrestricted
  },
}
```

When `assertFact` is called and the fact's category policy is `"never"`, a `ConsentRejectedError` is thrown:

```ts
import { ConsentRejectedError } from "@eidentic/memory";

try {
  await memory.assertFact(scope, { subject: "alice", predicate: "diagnosed_with", object: "diabetes", ... });
} catch (e) {
  if (e instanceof ConsentRejectedError) {
    // log/audit: alice's health data was rejected by the consent manifest
  }
}
```

The passive extraction path inside `ingest` catches `ConsentRejectedError` internally — `ingest` never throws on rejection.

### Retroactive sweep

When you update a manifest (e.g., a user withdraws consent for location data), call `applyConsent` to enforce the new rules over already-stored data:

```ts
const result = await memory.applyConsent(scope, {
  categories: { location: "never" },
});
// result.rejected      — facts/memories rejected outright
// result.sweptFacts    — existing facts invalidated (validUntil set, not deleted)
// result.sweptMemories — existing memory entries erased from caches + vector store
```

Invalidated facts preserve the temporal audit trail — their `validUntil` is set rather than the row being deleted. Memory entries are erased from in-memory caches and the vector store; the lexical FTS index does not support row deletion (a future `StorePort.removeMemory` would fully drop them).

### ConsentManifest options table

| Field | Type | Default | Description |
|---|---|---|---|
| `categories` | `Record<string, ConsentPolicy>` | required | Map from category label to policy (`"never"`, `"session"`, or retention ms). Categories not listed are unrestricted. |
| `classify` | `(text, fact?) => string \| undefined` | `defaultConsentClassifier` | Classify text into a category. Return `undefined` for unrestricted content. |
| `sessionTtlMs` | `number` | 30 minutes | TTL applied to `"session"`-policy content. |

---

## Export and portability

`memory.exportScope` produces a versioned, structured snapshot of everything stored for a scope — suitable for data-subject access requests and GDPR portability:

```ts
const exported = await memory.exportScope(scope);
// exported.schema       === "eidentic.memory.export.v1"
// exported.exportedAt   — ISO timestamp of the export
// exported.scope        — the scope that was exported
// exported.memories     — lexical entries: id, text, ingestedAt, metadata
// exported.facts        — full fact timeline (valid + invalidated, includes supersedes)
// exported.blocks       — always-in-context blocks at current version
// exported.blockHistory — per-block version history
```

The export is schema-versioned (`schema: "eidentic.memory.export.v1"`). Downstream tooling should inspect this discriminator for forward compatibility.

**Scope note:** memory entries are gathered from the in-process working set (the ids ingested in the current process). Facts and blocks are always fully exported because they use durable store queries. For a complete export across restarts, run the export in the same process that performed ingestion, or treat the facts + blocks portion as the canonical artifact.

---

## Identity merge

`memory.mergeScopes` upgrades an anonymous scope to an authenticated one — the canonical anonymous-to-authenticated upgrade path:

```ts
const counts = await memory.mergeScopes(
  { kind: "user", userId: "anon-123" },    // from (anonymous)
  { kind: "user", userId: "user-456" },    // to   (authenticated)
);
// counts.memories — entries re-indexed under the target scope
// counts.facts    — facts re-asserted under the target scope
// counts.blocks   — blocks copied (only labels absent in target)
```

### What moves

| Data | Behaviour |
|---|---|
| Memory entries | Re-indexed under `to` with `{ mergedFrom, mergedAt }` provenance metadata |
| Facts | Re-asserted under `to` in `validFrom` order; contradictions resolved per normal temporal invalidation |
| Blocks | Conservative copy — only labels **absent** in the target are copied; existing target blocks are never overwritten |
| Session history | **Does not move** — transcripts are not memory and stay under their original scope |

### Conflict strategies

Pass `{ conflict: "prefer-target" }` to skip source facts whose `(subject, predicate)` already has a currently-valid fact in the target:

```ts
await memory.mergeScopes(from, to, { conflict: "prefer-target" });
```

The default is `"keep-both"` — both versions are re-asserted, and temporal invalidation determines which wins based on `validFrom` ordering. Both versions remain visible in the timeline.

### Crash safety

The merge is **copy-then-erase**: the full copy phase completes and is verified before the source is erased. A failure mid-merge leaves the source intact — you can re-run safely (re-indexing by id and fact re-assertion are both idempotent).

---

## Gotchas

- **`factTimeline` requires a `graph`** — as do `assertFact`, `corroborate`, `applyConsent`, `exportScope`, and `mergeScopes`. Calling them without `graph` throws an explanatory error.
- **`applyConsent` memory-entry sweep is in-process only** — entries ingested in a prior process (after restart) are not in the in-memory caches and are skipped. Facts are the authoritative, restart-safe consent carrier and are always swept.
- **`"never"` invalidates, not deletes** — `applyConsent` sets `validUntil` on facts (audit preservation). Physical deletion requires `eraseScope`.
- **`mergeScopes` block copy is conservative** — it never overwrites target blocks. If you need to force-overwrite, call `memory.rewrite` explicitly after the merge.
- **Corroboration staleness is annotation-only** — stale facts are still returned in `retrieve()`. Filter on `s.stale` if you need to exclude them.

---

## See also

- [Memory 101](/guides/memory) — the core memory layers and wiring guide
- [Benchmarks](/guides/benchmarks) — write-quality and temporal point-in-time benchmarks for verifying these behaviours
