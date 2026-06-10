import { describe, it, expect } from "vitest";
import { MockEmbeddingModelV3 } from "ai/test";
import { AIEmbedder } from "../src/embedder.js";

function mock(vector: number[]) {
  return new MockEmbeddingModelV3({
    doEmbed: async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => vector),
      usage: { tokens: 1 },
    }),
  });
}

describe("AIEmbedder", () => {
  it("create() probes dimension from the model", async () => {
    const e = await AIEmbedder.create(mock([0.1, 0.2, 0.3, 0.4]));
    expect(e.dim).toBe(4);
  });

  it("embed() returns the provider vector as a plain number[]", async () => {
    const e = await AIEmbedder.create(mock([1, 2, 3]));
    const v = await e.embed("hello world");
    expect(v).toEqual([1, 2, 3]);
    expect(v.length).toBe(e.dim);
  });

  it("satisfies EmbeddingPort (dim is readonly number, embed returns number[])", async () => {
    const e = await AIEmbedder.create(mock([0, 0]));
    // structural: usable wherever EmbeddingPort is expected
    const port: { readonly dim: number; embed(t: string): Promise<number[]> } = e;
    expect(port.dim).toBe(2);
    expect(await port.embed("x")).toHaveLength(2);
  });
});
