import type { ModelPort, ModelRequest, ModelResponse, ModelStreamPart } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

/** Deterministic, order-stable JSON serialiser for cache keys. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const sorted = Object.keys(value as object).sort();
  return `{${sorted.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Default cache key: stable JSON of (messages, tools, model, outputSchema).
 * `signal` and `cacheControl` are intentionally excluded — they are
 * operational, not semantic.
 */
function defaultKeyFn(req: ModelRequest): string {
  return stableJson({
    messages: req.messages,
    tools: req.tools,
    model: req.model ?? null,
    outputSchema: req.outputSchema ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tiny LRU cache (no external deps)
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: ModelResponse;
  expiresAt: number; // epoch ms; Infinity = no TTL
}

class LRUCache {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly maxEntries: number) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh insertion order (LRU: move to end)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    // Evict the least-recently-used entry when over capacity
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Pluggable backing store for `cachedModel`. Implement this to share the
 *  cache across workers / survive restarts. */
export interface CacheStore {
  get(key: string): Promise<ModelResponse | undefined> | ModelResponse | undefined;
  set(key: string, value: ModelResponse, ttlMs?: number): Promise<void> | void;
}

export interface CachedModelOptions {
  /** How long a cached response is valid. Default: 5 minutes. */
  ttlMs?: number;
  /** Maximum number of entries in the in-process LRU. Default: 500. */
  maxEntries?: number;
  /**
   * Custom key derivation function. Receives the full request; return a
   * string that is unique for semantically-distinct requests.
   * Default: stable-JSON hash of messages + tools + model + outputSchema.
   */
  keyFn?: (req: ModelRequest) => string;
  /**
   * External cache store (Redis, Memcached, …). When provided, the LRU is
   * used as a local write-through layer and the store is consulted on misses.
   */
  store?: CacheStore;
  /**
   * Decide whether a successful result should be cached.
   * Default: cache all non-error results (always `true` on the happy path).
   *
   * **Tool-call responses are cached** at the model layer — tool definitions
   * are schemas only and carry no side-effects from the model's perspective.
   * This is desirable for replay scenarios. Override here if you need
   * per-request exclusions.
   */
  shouldCache?: (req: ModelRequest, result: ModelResponse) => boolean;
  /** Called on every cache hit (key, cached response). Use for metrics. */
  onCacheHit?: (key: string, result: ModelResponse) => void;
  /**
   * Clock used for TTL bookkeeping. Defaults to `Date.now`.
   * Inject a fake clock in tests for deterministic expiry behaviour.
   */
  clock?: () => number;
}

/** Runtime statistics exposed by `cachedModel`. */
export interface CacheStats {
  /** Number of requests served from cache. */
  hits: number;
  /** Number of requests that required a live model call. */
  misses: number;
  /** Current number of entries in the in-process LRU. */
  size: number;
}

/**
 * Wraps a `ModelPort` with an exact-match response cache for `complete()`.
 *
 * - **Streaming calls are never cached** and always pass through to the
 *   underlying model.
 * - The default key is a stable JSON hash of messages + tools + model +
 *   outputSchema. Provide `keyFn` to override.
 * - In-memory LRU (default 500 entries, 5-minute TTL) with optional
 *   external `store` for cross-process sharing.
 * - Inspect runtime behaviour via the returned `stats()` method.
 *
 * **Cost-optimization recipe**: enable caching for deterministic agent
 * sub-tasks — system prompts, classification prompts, or any prompt that
 * recurs verbatim within a session. Even a 20 % cache-hit rate on a
 * high-volume workload reduces spend by 20 % with zero changes elsewhere.
 * Documented combined savings of 55-65 % when combined with `withFallback`
 * + `routeModel`.
 *
 * @example
 * const model = cachedModel(baseModel, { ttlMs: 10 * 60_000, maxEntries: 1000 });
 * const { hits, misses, size } = model.stats();
 */
export function cachedModel(
  model: ModelPort,
  opts: CachedModelOptions = {},
): ModelPort & { stats(): CacheStats } {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxEntries = opts.maxEntries ?? 500;
  const keyFn = opts.keyFn ?? defaultKeyFn;
  const shouldCache = opts.shouldCache ?? (() => true);
  const clock = opts.clock ?? Date.now;

  const lru = new LRUCache(maxEntries);
  let hits = 0;
  let misses = 0;

  async function getFromCache(key: string): Promise<ModelResponse | undefined> {
    const now = clock();

    // 1. Check LRU first
    const local = lru.get(key);
    if (local) {
      if (local.expiresAt > now) return local.value;
      // Stale — fall through (the LRU will be overwritten on next set)
    }

    // 2. Check external store
    if (opts.store) {
      const stored = await opts.store.get(key);
      if (stored !== undefined) {
        // Promote to LRU
        lru.set(key, { value: stored, expiresAt: now + ttlMs });
        return stored;
      }
    }

    return undefined;
  }

  async function setInCache(key: string, value: ModelResponse): Promise<void> {
    const expiresAt = ttlMs === Infinity ? Infinity : clock() + ttlMs;
    lru.set(key, { value, expiresAt });
    if (opts.store) {
      await opts.store.set(key, value, ttlMs === Infinity ? undefined : ttlMs);
    }
  }

  const port = {
    get modelId() {
      return model.modelId;
    },

    async complete(request: ModelRequest): Promise<ModelResponse> {
      const key = keyFn(request);

      const cached = await getFromCache(key);
      if (cached !== undefined) {
        hits++;
        opts.onCacheHit?.(key, cached);
        return cached;
      }

      misses++;
      const result = await model.complete(request);

      if (shouldCache(request, result)) {
        await setInCache(key, result);
      }

      return result;
    },

    async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
      // Streaming responses are never cached — pass through unconditionally.
      if (!model.stream) {
        throw new Error("cachedModel: wrapped model does not implement stream()");
      }
      yield* model.stream(request);
    },

    stats(): CacheStats {
      return { hits, misses, size: lru.size };
    },
  };

  return port;
}
