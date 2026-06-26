import type { CostPolicy } from "@eidentic/types";

function withOverrides(base: CostPolicy, overrides: CostPolicy = {}): CostPolicy {
  return { ...base, ...overrides };
}

export const policies = {
  /** Tight budget for short drafts, labels, and small classification-style answers. */
  shortDraft(overrides?: CostPolicy): CostPolicy {
    return withOverrides({
      maxTurns: 2,
      maxTokens: 4_000,
      maxWallClockMs: 10_000,
      softCostUsd: 0.01,
      maxCostUsd: 0.03,
    }, overrides);
  },

  /** Default production budget for customer-facing replies with a small tool loop. */
  customerReply(overrides?: CostPolicy): CostPolicy {
    return withOverrides({
      maxTurns: 4,
      maxTokens: 8_000,
      maxWallClockMs: 20_000,
      softCostUsd: 0.03,
      maxCostUsd: 0.08,
    }, overrides);
  },

  /** Larger envelope for explicit research workflows. Avoid using this for auto-response paths. */
  longResearch(overrides?: CostPolicy): CostPolicy {
    return withOverrides({
      maxTurns: 8,
      maxTokens: 32_000,
      maxWallClockMs: 120_000,
      softCostUsd: 0.25,
      maxCostUsd: 0.75,
    }, overrides);
  },
} as const;
