import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";
import { Memory } from "../src/index.js";

const scope: Scope = { kind: "agent", agentId: "reindex-agent" };

function makeScopeKey(agentId: string): string {
  return `agent:${agentId}`;
}

describe("Memory.reindexEmbeddings", () => {
  it("re-embeds all vectors in scope with the new embedder (dim change)", async () => {
    // Setup: embedder A at dim=8
    const store = new InMemoryStore();
    const vector = new InMemoryVectorStore();
    const embedderA = new FakeEmbedder(8);
    const memA = new Memory({ store, vector, embedder: embedderA });

    // Ingest passages with embedder A
    await memA.ingest([
      { scope, id: "p1", text: "the cat sat on the mat" },
      { scope, id: "p2", text: "quantum entanglement is fascinating" },
      { scope, id: "p3", text: "hello world from eidentic" },
    ]);

    const sk = makeScopeKey("reindex-agent");

    // Verify dim=8 before reindex
    const beforeEntries = await vector.list(sk);
    expect(beforeEntries).toHaveLength(3);
    expect(beforeEntries.every((e) => e.vector.length === 8)).toBe(true);

    // Construct a NEW Memory over the SAME store+vector but with embedder B at dim=16
    const embedderB = new FakeEmbedder(16);
    const memB = new Memory({ store, vector, embedder: embedderB });

    // Reindex with embedder B
    const result = await memB.reindexEmbeddings(scope);
    expect(result.reindexed).toBe(3);

    // Verify all vectors now have dim=16
    const afterEntries = await vector.list(sk);
    expect(afterEntries).toHaveLength(3);
    expect(afterEntries.every((e) => e.vector.length === 16)).toBe(true);

    // Verify vectors changed (embedderB produces different vectors than embedderA for same text)
    const p1After = afterEntries.find((e) => e.id === "p1")!;
    expect(p1After).toBeDefined();
    expect(p1After.text).toBe("the cat sat on the mat");

    // Retrieval still works after reindex
    const qv = await embedderB.embed("cat mat");
    const hits = await vector.search(qv, sk, 5);
    expect(hits.length).toBeGreaterThan(0);
    // The cat/mat passage should surface near the top
    expect(hits.some((h) => h.id === "p1")).toBe(true);
  });

  it("re-embeds with the same embedder (same-model reindex is idempotent for text content)", async () => {
    const store = new InMemoryStore();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(8);
    const mem = new Memory({ store, vector, embedder });

    await mem.ingest([
      { scope, id: "q1", text: "same embedder reindex test" },
    ]);

    const sk = makeScopeKey("reindex-agent");
    const before = await vector.list(sk);
    const beforeVec = before[0]!.vector;

    const result = await mem.reindexEmbeddings(scope);
    expect(result.reindexed).toBe(1);

    const after = await vector.list(sk);
    // Same embedder → same deterministic vector
    expect(after[0]!.vector).toEqual(beforeVec);
  });

  it("is a no-op when semantic is off (no vector+embedder)", async () => {
    const store = new InMemoryStore();
    const mem = new Memory({ store }); // lexical-only

    // Lexical-only ingest
    await mem.ingest([{ scope, id: "l1", text: "something" }]);

    const result = await mem.reindexEmbeddings(scope);
    expect(result.reindexed).toBe(0);
  });

  it("is a no-op when the vector store has no entries for the scope", async () => {
    const store = new InMemoryStore();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(8);
    const mem = new Memory({ store, vector, embedder });

    // Nothing ingested
    const result = await mem.reindexEmbeddings(scope);
    expect(result.reindexed).toBe(0);
  });

  it("count matches the number of passages ingested", async () => {
    const store2 = new InMemoryStore();
    const vector2 = new InMemoryVectorStore();
    const emb = new FakeEmbedder(4);
    const memC = new Memory({ store: store2, vector: vector2, embedder: emb });
    const scope2: Scope = { kind: "agent", agentId: "ri-count" };

    await memC.ingest([
      { scope: scope2, id: "c1", text: "one" },
      { scope: scope2, id: "c2", text: "two" },
      { scope: scope2, id: "c3", text: "three" },
      { scope: scope2, id: "c4", text: "four" },
    ]);

    const result = await memC.reindexEmbeddings(scope2);
    expect(result.reindexed).toBe(4);
  });

  it("scope-isolated: reindexing scope A does not affect scope B vectors", async () => {
    const store3 = new InMemoryStore();
    const vector3 = new InMemoryVectorStore();
    const embA = new FakeEmbedder(8);
    const memA2 = new Memory({ store: store3, vector: vector3, embedder: embA });

    const scopeA: Scope = { kind: "agent", agentId: "ri-iso-a" };
    const scopeB: Scope = { kind: "agent", agentId: "ri-iso-b" };

    await memA2.ingest([{ scope: scopeA, id: "a1", text: "alpha" }]);
    await memA2.ingest([{ scope: scopeB, id: "b1", text: "beta" }]);

    const skB = makeScopeKey("ri-iso-b");
    const bBefore = await vector3.list(skB);
    const bVecBefore = [...bBefore[0]!.vector];

    // Reindex only scope A
    const embB2 = new FakeEmbedder(16);
    const memB2 = new Memory({ store: store3, vector: vector3, embedder: embB2 });
    await memB2.reindexEmbeddings(scopeA);

    // Scope B vectors must be unchanged
    const bAfter = await vector3.list(skB);
    expect(bAfter[0]!.vector).toEqual(bVecBefore);
    expect(bAfter[0]!.vector.length).toBe(8); // still dim=8
  });
});
