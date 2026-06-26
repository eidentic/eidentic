import { describe, it, expect } from "vitest";
import { policies } from "../src/policies.js";

describe("Cost policy presets", () => {
  it("customerReply returns production reply defaults and accepts overrides", () => {
    expect(policies.customerReply()).toMatchObject({
      maxTurns: 4,
      maxTokens: 8_000,
      maxWallClockMs: 20_000,
      softCostUsd: 0.03,
      maxCostUsd: 0.08,
    });
    expect(policies.customerReply({ maxTurns: 2, maxCostUsd: 0.02 })).toMatchObject({
      maxTurns: 2,
      maxTokens: 8_000,
      maxCostUsd: 0.02,
    });
  });

  it("shortDraft and longResearch expose distinct envelopes", () => {
    expect(policies.shortDraft().maxTokens).toBeLessThan(policies.longResearch().maxTokens!);
    expect(policies.shortDraft().maxWallClockMs).toBeLessThan(policies.longResearch().maxWallClockMs!);
  });
});
