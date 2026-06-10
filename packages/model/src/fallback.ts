import type { ModelPort, ModelRequest, ModelResponse, ModelStreamPart } from "@eidentic/types";

export interface WithFallbackOptions {
  /**
   * Custom predicate to decide whether an error should trigger fallback.
   * Called with the thrown error. Return `true` to try the next model.
   * Default: always fall back (except for AbortError — see below).
   */
  shouldFallback?: (err: unknown) => boolean;
  /**
   * Called each time a fallback transition happens.
   * Useful for alerting/metrics — e.g. log to your observability stack.
   */
  onFallback?: (err: unknown, fromIndex: number, toIndex: number) => void;
}

function isAbortError(err: unknown): boolean {
  // DOMException AbortError (browser + Node 18+) or name-duck-typed
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

function shouldTryNext(err: unknown, opts?: WithFallbackOptions): boolean {
  // AbortErrors are never retried — respecting the caller's cancellation is mandatory.
  if (isAbortError(err)) return false;
  if (opts?.shouldFallback) return opts.shouldFallback(err);
  return true;
}

/**
 * Wraps a primary `ModelPort` with one or more fallback models.
 *
 * On failure of `complete()` or `stream()` (network error, provider 5xx/429,
 * or a custom `shouldFallback` predicate), the next model in the chain is tried.
 *
 * **Stream caveat**: fallback is only attempted when the failed stream produced
 * **zero** text deltas. If any delta was already yielded to the caller, the
 * output would be corrupted by a mid-stream provider switch, so the error is
 * re-thrown instead.
 *
 * **AbortError**: never triggers a fallback — the caller's cancellation intent
 * is always respected.
 *
 * **Cost-optimization recipe**: pair a cheaper, faster tier as the primary with
 * a slower but more-capable tier as fallback. Under normal conditions you pay
 * the cheap rate; spikes or outages automatically route to the reliable tier
 * without changing any call sites. Documented 55-65 % cost reductions in
 * production systems that apply this pattern.
 *
 * @example
 * const model = withFallback(cheap, [premium], {
 *   onFallback: (err, from, to) => console.warn(`model[${from}] failed, trying [${to}]`, err),
 * });
 * // Drop into any AgentConfig.model unchanged — it is still a ModelPort.
 */
export function withFallback(
  primary: ModelPort,
  fallbacks: ModelPort[],
  opts?: WithFallbackOptions,
): ModelPort {
  const chain = [primary, ...fallbacks];

  return {
    // Expose the primary's modelId so AgentConfig can read it.
    get modelId() {
      return primary.modelId;
    },

    async complete(request: ModelRequest): Promise<ModelResponse> {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        try {
          return await chain[i]!.complete(request);
        } catch (err) {
          lastErr = err;
          if (i < chain.length - 1 && shouldTryNext(err, opts)) {
            opts?.onFallback?.(err, i, i + 1);
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    },

    async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
      let lastErr: unknown;
      for (let i = 0; i < chain.length; i++) {
        const model = chain[i]!;
        const streamFn = model.stream?.bind(model);
        if (!streamFn) {
          // This model does not support streaming — fall through to complete() shim
          // by trying the next one in the chain (or throw if we're at the end).
          lastErr = new Error(`model at index ${i} does not implement stream()`);
          if (i < chain.length - 1 && shouldTryNext(lastErr, opts)) {
            opts?.onFallback?.(lastErr, i, i + 1);
            continue;
          }
          throw lastErr;
        }

        let deltasSeen = 0;
        try {
          for await (const part of streamFn(request)) {
            if (part.type === "delta") deltasSeen++;
            yield part;
          }
          return; // success
        } catch (err) {
          lastErr = err;
          // Mid-stream failover would corrupt output already sent to the caller.
          if (deltasSeen > 0) throw err;
          if (i < chain.length - 1 && shouldTryNext(err, opts)) {
            opts?.onFallback?.(err, i, i + 1);
            continue;
          }
          throw err;
        }
      }
      throw lastErr;
    },
  };
}
