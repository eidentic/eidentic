import { describe, it, expect } from "vitest";

// This test hits a real provider and is SKIPPED unless ANTHROPIC_API_KEY is set.
// It never runs in CI (no secret configured). Run locally with a key to verify end-to-end.
const live = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

live("AIModel (live Anthropic)", () => {
  it("completes a simple prompt and reports usage", async () => {
    const { AIModel } = await import("../src/model.js");
    const { anthropic } = await import("@ai-sdk/anthropic");
    const port = new AIModel(anthropic("claude-sonnet-4-5"));
    const res = await port.complete({
      messages: [
        { role: "system", content: "Answer in one word." },
        { role: "user", content: "Say 'pong'." },
      ],
      tools: [],
    });
    const text = res.content.find((b) => b.type === "text");
    expect(text).toBeDefined();
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  }, 30_000);
});
