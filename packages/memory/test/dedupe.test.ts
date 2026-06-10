import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, type Scope, type ModelResponse } from "@eidentic/types";
import { Memory } from "../src/index.js";

const scope: Scope = { kind: "agent", agentId: "dedup-agent" };

/** Build a ModelResponse with a merge_passages tool call. */
function mergeResponse(passage: string, usage: { inputTokens: number; outputTokens: number }): ModelResponse {
  return {
    content: [toolUseBlock("m1", "merge_passages", { passage })],
    usage,
  };
}

/** Build a ModelResponse with only a text block (no tool call — simulates malformed response). */
function emptyResponse(usage: { inputTokens: number; outputTokens: number }): ModelResponse {
  return {
    content: [{ type: "text", text: "I could not merge." }],
    usage,
  };
}

function makeSemanticMemory() {
  const store = new InMemoryStore();
  const vector = new InMemoryVectorStore();
  const embedder = new FakeEmbedder(16);
  // dedupeOnWrite: false — these tests intentionally seed identical passages to exercise
  // deduplicateArchival (the LLM-merge dedup path), which is distinct from write-time dedup.
  const mem = new Memory({ store, vector, embedder, dedupeOnWrite: false });
  return { store, vector, embedder, mem };
}

describe("Memory.deduplicateArchival", () => {
  it("merges two near-identical passages into one canonical entry", async () => {
    const { store, vector, mem } = makeSemanticMemory();
    const model = new MockModel([mergeResponse("the user prefers dark mode (canonical)", { inputTokens: 50, outputTokens: 20 })]);

    // Ingest two nearly identical passages
    await mem.ingest([
      { scope, id: "p1", text: "the user prefers dark mode" },
      { scope, id: "p2", text: "the user prefers dark mode" },
    ]);

    const res = await mem.deduplicateArchival(scope, { mergeModel: model, threshold: 0.95 });

    expect(res.merged).toBe(1);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 20 });

    // Vector store should have 1 entry (p2 deleted, p1 updated)
    const sk = `agent:dedup-agent`;
    const listed = await vector.list(sk);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.text).toContain("canonical");

    // FTS should find the canonical text
    const hits = await store.searchMemory(scope, "canonical dark mode", 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does NOT merge dissimilar passages", async () => {
    const { vector, mem } = makeSemanticMemory();
    const model = new MockModel([]);

    await mem.ingest([
      { scope, id: "d1", text: "the user likes coffee" },
      { scope, id: "d2", text: "quantum entanglement is fascinating" },
    ]);

    const res = await mem.deduplicateArchival(scope, { mergeModel: model, threshold: 0.95 });

    expect(res.merged).toBe(0);
    expect(model.calls).toHaveLength(0);

    const sk = `agent:dedup-agent`;
    const listed = await vector.list(sk);
    expect(listed).toHaveLength(2);
  });

  it("leaves BOTH originals intact on a malformed merge response", async () => {
    const { vector, mem } = makeSemanticMemory();
    const model = new MockModel([emptyResponse({ inputTokens: 50, outputTokens: 0 })]);

    await mem.ingest([
      { scope, id: "m1", text: "the user prefers dark mode" },
      { scope, id: "m2", text: "the user prefers dark mode" },
    ]);

    const res = await mem.deduplicateArchival(scope, { mergeModel: model, threshold: 0.95 });

    expect(res.merged).toBe(0);
    // Usage is surfaced even though merge was not applied
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 0 });

    const sk = `agent:dedup-agent`;
    const listed = await vector.list(sk);
    expect(listed).toHaveLength(2);
  });

  it("is a no-op without a mergeModel", async () => {
    const { vector, mem } = makeSemanticMemory();

    await mem.ingest([
      { scope, id: "n1", text: "the user prefers dark mode" },
      { scope, id: "n2", text: "the user prefers dark mode" },
    ]);

    const res = await mem.deduplicateArchival(scope);

    expect(res.merged).toBe(0);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const sk = `agent:dedup-agent`;
    const listed = await vector.list(sk);
    expect(listed).toHaveLength(2);
  });

  it("is a no-op when semantic is off (no vector/embedder)", async () => {
    const store = new InMemoryStore();
    // dedupeOnWrite: false — seeding identical passages to test the archival dedup path
    const mem = new Memory({ store, dedupeOnWrite: false });
    const model = new MockModel([]);

    // Lexical-only ingest
    await mem.ingest([
      { scope, id: "l1", text: "the user prefers dark mode" },
      { scope, id: "l2", text: "the user prefers dark mode" },
    ]);

    const res = await mem.deduplicateArchival(scope, { mergeModel: model });

    expect(res.merged).toBe(0);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(model.calls).toHaveLength(0);
  });
});
