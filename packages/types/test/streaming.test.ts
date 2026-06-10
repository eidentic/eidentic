import { describe, it, expect } from "vitest";
import { StreamMockModel } from "../src/testing.js";
import type { ModelStreamPart, ModelResponse } from "../src/index.js";

describe("StreamMockModel", () => {
  it("streams deltas then a final response, and complete() returns the same response", async () => {
    const response: ModelResponse = { content: [{ type: "text", text: "Hello" }], usage: { inputTokens: 3, outputTokens: 2 } };
    const m = new StreamMockModel([{ deltas: ["Hel", "lo"], response }]);

    const parts: ModelStreamPart[] = [];
    for await (const p of m.stream({ messages: [], tools: [] })) parts.push(p);

    expect(parts).toEqual([
      { type: "delta", delta: { text: "Hel" } },
      { type: "delta", delta: { text: "lo" } },
      { type: "final", response },
    ]);

    const m2 = new StreamMockModel([{ deltas: ["x"], response }]);
    expect(await m2.complete({ messages: [], tools: [] })).toEqual(response);
  });
});
