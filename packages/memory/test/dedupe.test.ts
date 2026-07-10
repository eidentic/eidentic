import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, type Scope, type ModelResponse, type VectorPort } from "@eidentic/types";
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
  it("bounds the default work at 100k comparisons for a 10k-entry scope and reports truncation", async () => {
    const entryCount = 10_000;
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      id: `bulk-${i}`,
      scopeKey: "agent:dedup-agent",
      text: `passage ${i}`,
      vector: [1],
    }));
    const vector: VectorPort = {
      upsert: async () => {},
      search: async () => [],
      delete: async () => {},
      eraseScope: async () => ({ deleted: 0 }),
      list: async () => entries,
    };
    const model = new MockModel([]);
    const mem = new Memory({
      store: new InMemoryStore(),
      vector,
      embedder: { dim: 1, embed: async () => [1] },
      dedupeOnWrite: false,
    });

    // threshold > 1 guarantees the model is never called; the test measures candidate work only.
    const res = await mem.deduplicateArchival(scope, { mergeModel: model, threshold: 1.01 });

    expect(res).toMatchObject({
      merged: 0,
      comparisons: 100_000,
      comparisonBudget: 100_000,
      totalPairs: 49_995_000,
      truncated: true,
    });
    expect(model.calls).toHaveLength(0);
  });

  it("spreads a small explicit budget across the scope before widening candidate distance", async () => {
    const entries = [
      { id: "p0", scopeKey: "agent:dedup-agent", text: "zero", vector: [1, 0] },
      { id: "p1", scopeKey: "agent:dedup-agent", text: "one", vector: [0, 1] },
      { id: "p2", scopeKey: "agent:dedup-agent", text: "two", vector: [-1, 0] },
      { id: "p3", scopeKey: "agent:dedup-agent", text: "duplicate A", vector: [0, -1] },
      { id: "p4", scopeKey: "agent:dedup-agent", text: "duplicate B", vector: [0, -1] },
    ];
    const vector: VectorPort = {
      upsert: async () => {},
      search: async () => [],
      delete: async () => {},
      eraseScope: async () => ({ deleted: 0 }),
      list: async () => entries,
    };
    const model = new MockModel([mergeResponse("canonical duplicate", { inputTokens: 3, outputTokens: 1 })]);
    const mem = new Memory({
      store: new InMemoryStore(),
      vector,
      embedder: { dim: 2, embed: async () => [0, -1] },
      dedupeOnWrite: false,
    });

    const res = await mem.deduplicateArchival(scope, {
      mergeModel: model,
      threshold: 0.95,
      maxComparisons: 4,
    });

    // Distance-one ordering checks (0,1), (1,2), (2,3), then the tail pair (3,4).
    // An anchor-first prefix would spend all four slots around p0 and miss this duplicate.
    expect(res).toMatchObject({
      merged: 1,
      comparisons: 4,
      candidatePairsExamined: 4,
      comparisonBudget: 4,
      totalPairs: 10,
      truncated: true,
    });
    expect(model.calls).toHaveLength(1);
  });

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
    expect(await store.listMemory(scope)).toHaveLength(1);
  });

  it("bounds LLM merge calls and reports truncation", async () => {
    const { store, mem } = makeSemanticMemory();
    const model = new MockModel([
      mergeResponse("canonical one", { inputTokens: 2, outputTokens: 1 }),
      mergeResponse("canonical two", { inputTokens: 2, outputTokens: 1 }),
    ]);
    await mem.ingest([
      { scope, id: "b1", text: "same passage" },
      { scope, id: "b2", text: "same passage" },
      { scope, id: "b3", text: "same passage" },
    ]);
    const result = await mem.deduplicateArchival(scope, {
      mergeModel: model,
      threshold: 0.95,
      maxMerges: 1,
    });
    expect(result).toMatchObject({ merged: 1, mergeBudget: 1, truncated: true });
    expect(model.calls).toHaveLength(1);
    expect(await store.listMemory(scope)).toHaveLength(2);
  });

  it("honors an already-aborted maintenance signal", async () => {
    const { mem } = makeSemanticMemory();
    const controller = new AbortController();
    controller.abort();
    await expect(mem.deduplicateArchival(scope, {
      mergeModel: new MockModel([]),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
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
