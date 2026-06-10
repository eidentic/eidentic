---
title: Model Routing & Cost Recipes
description: withFallback, routeModel, byTokenEstimate, cachedModel — route requests to the right model tier and control cost.
---

`@eidentic/model` ships composable wrappers that implement `ModelPort`, so they drop into `AgentConfig.model` without any other changes.

## `withFallback` — resilience + cost optimization

Wraps a primary model with one or more fallbacks. On failure the next model in the chain is tried automatically.

```ts
import { AIModel } from "@eidentic/model";
import { withFallback } from "@eidentic/model";

const model = withFallback(
  new AIModel(provider("fast-cheap-model")),   // primary: cheap tier
  [new AIModel(provider("powerful-model"))],   // fallback: premium tier
  {
    onFallback: (err, from, to) =>
      logger.warn(`model[${from}] failed, trying [${to}]`, String(err)),
  },
);
```

**Stream caveat:** fallback is only attempted when the failing stream produced zero text deltas. If output was already yielded to the caller, switching providers mid-stream would corrupt output.

**Cost recipe:** assign the cheap/fast model as primary and the powerful model as fallback. Under normal conditions you pay the cheap rate; provider outages or 429s transparently route to the reliable tier. Production systems applying this pattern report 55–65 % spend reductions.

### Options (`WithFallbackOptions`)

| Option | Type | Description |
|---|---|---|
| `shouldFallback` | `(err) => boolean` | Override the default "always fallback" predicate. `AbortError` is never retried regardless. |
| `onFallback` | `(err, fromIdx, toIdx) => void` | Alerting / metrics hook for fallback transitions |

---

## `routeModel` + `byTokenEstimate` — token-based routing

Routes each request to a named model tier based on estimated prompt size.

```ts
import { routeModel, byTokenEstimate, AIModel } from "@eidentic/model";

const model = routeModel(
  byTokenEstimate(
    [
      { upTo: 4_000,  tier: "small" },
      { upTo: 32_000, tier: "medium" },
    ],
    "large", // fallback tier for prompts > 32 k tokens
  ),
  {
    small:  new AIModel(provider("small-fast-model")),
    medium: new AIModel(provider("mid-model")),
    large:  new AIModel(provider("big-model")),
  },
);
```

`byTokenEstimate` uses a conservative character-based estimator (chars ÷ 4). For routing decisions ±20 % accuracy is sufficient. Thresholds are evaluated in ascending `upTo` order; the first match wins.

**Cost recipe:** short requests (the majority in practice) pay the small-tier rate; only genuinely large prompts pay the premium. This alone yields 40–60 % spend reductions in production workloads.

### Custom selector

Supply any function `(req: ModelRequest) => string` as the selector:

```ts
const model = routeModel(
  (req) => req.messages.length > 10 ? "powerful" : "fast",
  { fast: cheapModel, powerful: premiumModel },
);
```

An unknown tier name throws immediately with a clear diagnostic message.

---

## `cachedModel` — deterministic response caching

Wraps a model with an LRU cache. Identical requests return the cached response without calling the provider — useful for evals, demos, and deterministic tests.

```ts
import { cachedModel } from "@eidentic/model";

const model = cachedModel(new AIModel(provider("model-id")), {
  ttlMs: 10 * 60 * 1000, // 10-minute TTL
  maxEntries: 1000,
});
```

### Options (`CachedModelOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `ttlMs` | `number` | `300_000` (5 min) | Cache entry TTL in milliseconds |
| `maxEntries` | `number` | `500` | In-process LRU size |
| `store` | `CacheStore` | — | External cache store (shared across workers; implement `get`/`set`) |
| `keyFn` | `(req) => string` | Stable JSON of messages+tools+model+outputSchema | Custom cache key derivation |

### Pluggable backing store

```ts
import { cachedModel, type CacheStore } from "@eidentic/model";
import { createClient } from "redis";

const redis = await createClient().connect();

const redisStore: CacheStore = {
  async get(key) {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : undefined;
  },
  async set(key, value, ttlMs) {
    await redis.set(key, JSON.stringify(value), { PX: ttlMs });
  },
};

const model = cachedModel(new AIModel(provider("model")), { store: redisStore });
```

---

## Composing wrappers with cost ceilings

All wrappers implement `ModelPort` so they nest freely:

```ts
import { withFallback, routeModel, byTokenEstimate, cachedModel, AIModel } from "@eidentic/model";

// 1. Start with routing
const routed = routeModel(
  byTokenEstimate([{ upTo: 8_000, tier: "small" }], "large"),
  { small: cheapModel, large: premiumModel },
);

// 2. Layer in fallback resilience
const resilient = withFallback(routed, [ultimateFallback]);

// 3. Add response caching
const model = cachedModel(resilient, { ttlMs: 5 * 60 * 1000 });

// 4. Apply cost ceilings at the agent level
const agent = new Agent({
  id: "assistant",
  model,
  store,
  prices: defaultPrices,
  policy: { maxCostUsd: 1.00, softCostUsd: 0.50 },
  onCostThreshold: (info) => console.warn("Approaching cost ceiling:", info),
});
```

## Gotchas

- `cachedModel` only caches `complete()` responses, not streaming. `stream()` calls always go to the real model.
- `withFallback` exposes the primary model's `modelId` for price lookups and span attributes.
- `routeModel` returns `modelId: undefined` since the id is request-specific — set `AgentConfig.modelId` explicitly when you need span attributes.
