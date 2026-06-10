import { describe, it, expect } from "vitest";
import { mapLiteLLM, fetchLatestPrices } from "../src/fetch-prices.js";
import { defaultPrices, pricesUpdatedAt } from "../src/prices.js";

// ---------------------------------------------------------------------------
// mapLiteLLM — pure mapping, no network
// ---------------------------------------------------------------------------

const FAKE_LITELLM: Record<string, unknown> = {
  // Anthropic direct
  "claude-test-model": {
    litellm_provider: "anthropic",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    mode: "chat",
  },
  // Provider-prefixed key — should yield a bare key too
  "anthropic/claude-prefixed": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    mode: "chat",
  },
  // OpenAI with cache
  "gpt-test": {
    litellm_provider: "openai",
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 1.25e-6,
    mode: "chat",
  },
  // Gemini prefixed — bare key should be generated
  "gemini/gemini-test": {
    litellm_provider: "gemini",
    input_cost_per_token: 0.35e-6,
    output_cost_per_token: 1.05e-6,
    cache_read_input_token_cost: 0.0875e-6,
    mode: "chat",
  },
  // No cache — should omit cachedInputPerMTok
  "deepseek-no-cache": {
    litellm_provider: "deepseek",
    input_cost_per_token: 2.8e-7,
    output_cost_per_token: 4.2e-7,
    mode: "chat",
  },
  // Excluded provider — should not appear
  "aws-bedrock-model": {
    litellm_provider: "bedrock",
    input_cost_per_token: 0.5e-6,
    output_cost_per_token: 2.5e-6,
    mode: "chat",
  },
  // Missing costs — should be excluded
  "no-costs-model": {
    litellm_provider: "anthropic",
    mode: "chat",
  },
};

describe("mapLiteLLM", () => {
  it("maps input/output costs to per-MTok values", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    expect(table["claude-test-model"]).toBeDefined();
    expect(table["claude-test-model"]!.inputPerMTok).toBeCloseTo(3.0, 5);
    expect(table["claude-test-model"]!.outputPerMTok).toBeCloseTo(15.0, 5);
  });

  it("maps cache_read_input_token_cost to cachedInputPerMTok", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    expect(table["claude-test-model"]!.cachedInputPerMTok).toBeCloseTo(0.3, 5);
    expect(table["gpt-test"]!.cachedInputPerMTok).toBeCloseTo(1.25, 5);
  });

  it("omits cachedInputPerMTok when no cache_read cost present", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    expect(table["deepseek-no-cache"]).toBeDefined();
    expect(table["deepseek-no-cache"]!.cachedInputPerMTok).toBeUndefined();
  });

  it("generates a bare key for provider-prefixed entries", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    // gemini/gemini-test → gemini-test bare key
    expect(table["gemini-test"]).toBeDefined();
    expect(table["gemini-test"]!.inputPerMTok).toBeCloseTo(0.35, 5);
    // anthropic/claude-prefixed → claude-prefixed
    expect(table["claude-prefixed"]).toBeDefined();
    expect(table["claude-prefixed"]!.inputPerMTok).toBeCloseTo(1.0, 5);
  });

  it("excludes providers not in the target set (e.g. bedrock)", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    expect(table["aws-bedrock-model"]).toBeUndefined();
  });

  it("excludes entries missing input or output cost", () => {
    const table = mapLiteLLM(FAKE_LITELLM);
    expect(table["no-costs-model"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchLatestPrices — injected fake fetch, no network
// ---------------------------------------------------------------------------

describe("fetchLatestPrices", () => {
  it("fetches JSON and returns a mapped PriceTable via injected fetch", async () => {
    const fakeFetch = async (_url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => FAKE_LITELLM,
      }) as unknown as Response;

    const table = await fetchLatestPrices({ fetchImpl: fakeFetch });
    expect(table["claude-test-model"]).toBeDefined();
    expect(table["claude-test-model"]!.inputPerMTok).toBeCloseTo(3.0, 5);
    expect(table["gpt-test"]!.cachedInputPerMTok).toBeCloseTo(1.25, 5);
  });

  it("throws a clear error on non-ok HTTP response", async () => {
    const fakeFetch = async (_url: string) =>
      ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      }) as unknown as Response;

    await expect(fetchLatestPrices({ fetchImpl: fakeFetch })).rejects.toThrow("HTTP 503");
  });

  it("throws a clear error on network failure", async () => {
    const fakeFetch = async (_url: string) => {
      throw new Error("ECONNREFUSED");
    };

    await expect(fetchLatestPrices({ fetchImpl: fakeFetch })).rejects.toThrow("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// defaultPrices smoke tests
// ---------------------------------------------------------------------------

describe("defaultPrices", () => {
  it("is a non-empty object", () => {
    expect(Object.keys(defaultPrices).length).toBeGreaterThan(50);
  });

  it("contains known Anthropic models with positive prices", () => {
    const anthropicKeys = Object.keys(defaultPrices).filter((k) =>
      k.includes("claude"),
    );
    expect(anthropicKeys.length).toBeGreaterThan(0);
    const entry = defaultPrices[anthropicKeys[0]!]!;
    expect(entry.inputPerMTok).toBeGreaterThan(0);
    expect(entry.outputPerMTok).toBeGreaterThan(0);
  });

  it("contains known OpenAI models with positive prices", () => {
    const openaiKeys = Object.keys(defaultPrices).filter((k) => k.startsWith("gpt-"));
    expect(openaiKeys.length).toBeGreaterThan(0);
    const entry = defaultPrices[openaiKeys[0]!]!;
    expect(entry.inputPerMTok).toBeGreaterThan(0);
    expect(entry.outputPerMTok).toBeGreaterThan(0);
  });

  it("has claude-sonnet-4-5 with cache pricing", () => {
    const e = defaultPrices["claude-sonnet-4-5"];
    expect(e).toBeDefined();
    expect(e!.inputPerMTok).toBeCloseTo(3.0, 4);
    expect(e!.outputPerMTok).toBeCloseTo(15.0, 4);
    expect(e!.cachedInputPerMTok).toBeCloseTo(0.3, 4);
  });

  it("has gpt-4o with cache pricing", () => {
    const e = defaultPrices["gpt-4o"];
    expect(e).toBeDefined();
    expect(e!.inputPerMTok).toBeCloseTo(2.5, 4);
    expect(e!.outputPerMTok).toBeCloseTo(10.0, 4);
    expect(e!.cachedInputPerMTok).toBeCloseTo(1.25, 4);
  });

  it("pricesUpdatedAt is a valid ISO date string", () => {
    expect(pricesUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(pricesUpdatedAt).getTime()).toBeGreaterThan(0);
  });
});
