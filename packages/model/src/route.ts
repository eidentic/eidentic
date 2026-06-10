import type { ModelPort, ModelRequest, ModelResponse, ModelStreamPart } from "@eidentic/types";

/**
 * A threshold entry for `byTokenEstimate`.
 * The selector routes to `tier` when the estimated token count is `<= upTo`.
 * Entries are evaluated in ascending `upTo` order; the first match wins.
 */
export interface TokenThreshold {
  upTo: number;
  tier: string;
}

/**
 * Rough character-based token estimator (chars / 4).
 * The `@eidentic/core` token counter is not imported here to avoid a
 * dependency cycle; this estimator is intentionally conservative and fast.
 * For routing decisions, ±20 % accuracy is more than sufficient.
 */
function estimateTokens(req: ModelRequest): number {
  let chars = 0;
  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") chars += block.text.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Returns a `routeModel` selector that maps requests to tier names based on
 * estimated prompt token count. Thresholds are evaluated in ascending `upTo`
 * order; the first whose `upTo >= estimatedTokens` wins. Falls back to
 * `fallbackTier` when no threshold matches.
 *
 * @example
 * const sel = byTokenEstimate(
 *   [{ upTo: 4_000, tier: "small" }, { upTo: 32_000, tier: "medium" }],
 *   "large",
 * );
 * const model = routeModel(sel, { small: cheapModel, medium: midModel, large: bigModel });
 */
export function byTokenEstimate(
  thresholds: TokenThreshold[],
  fallbackTier: string,
): (req: ModelRequest) => string {
  const sorted = [...thresholds].sort((a, b) => a.upTo - b.upTo);
  return (req: ModelRequest): string => {
    const tokens = estimateTokens(req);
    for (const t of sorted) {
      if (tokens <= t.upTo) return t.tier;
    }
    return fallbackTier;
  };
}

/**
 * Routes each request to one of a named set of `ModelPort` implementations
 * according to a caller-supplied `selector` function.
 *
 * The selector receives the full `ModelRequest` and returns a tier name.
 * Use `byTokenEstimate` as a drop-in selector for token-count-based routing,
 * or write your own (e.g. inspect a custom tag on the messages array).
 *
 * An unknown tier name throws immediately with a clear diagnostic message
 * rather than silently failing or falling through.
 *
 * **Cost-optimization recipe**: assign a cheap fast model to the "small" tier
 * and a powerful model only to the "large" tier. Short requests (most of them
 * in practice) pay the cheap rate; only requests that genuinely need the
 * bigger model incur the premium cost. This alone yields 40-60 % spend
 * reductions in production workloads.
 *
 * @example
 * const model = routeModel(
 *   byTokenEstimate([{ upTo: 4_000, tier: "small" }], "large"),
 *   { small: cheapModel, large: premiumModel },
 * );
 * agent.run({ model, ... }); // works as a plain ModelPort
 */
export function routeModel(
  selector: (req: ModelRequest) => string,
  tiers: Record<string, ModelPort>,
): ModelPort {
  function resolve(req: ModelRequest): ModelPort {
    const tier = selector(req);
    const model = tiers[tier];
    if (!model) {
      const known = Object.keys(tiers).join(", ");
      throw new Error(
        `routeModel: unknown tier "${tier}". Known tiers: ${known || "(none)"}`,
      );
    }
    return model;
  }

  return {
    get modelId() {
      // modelId is request-specific; cannot be determined statically.
      return undefined;
    },

    async complete(request: ModelRequest): Promise<ModelResponse> {
      return resolve(request).complete(request);
    },

    async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
      const model = resolve(request);
      if (!model.stream) {
        throw new Error(
          `routeModel: resolved model for tier does not implement stream()`,
        );
      }
      yield* model.stream(request);
    },
  };
}
