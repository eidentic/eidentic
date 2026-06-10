import { describe, it, expect } from "vitest";

// Real model download (~129MB) — SKIPPED unless EIDENTIC_TEST_MODELS=1. Never runs in CI.
const models = process.env.EIDENTIC_TEST_MODELS ? describe : describe.skip;

models("LocalEmbedder (real bge-small-en-v1.5)", () => {
  it("embeds to 384 dims and ranks a paraphrase above an unrelated sentence", async () => {
    const { LocalEmbedder } = await import("../src/index.js");
    const e = await LocalEmbedder.load();
    expect(e.dim).toBe(384);
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = await e.embed("favorite programming language");
    const ts = await e.embed("I really enjoy writing TypeScript code");
    const food = await e.embed("My favorite food is sushi");
    expect(cos(q, ts)).toBeGreaterThan(cos(q, food));
  }, 60_000);
});
