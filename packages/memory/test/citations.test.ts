/**
 * Feature 3 — RAG citations: Memory.ingest stores metadata; Memory.retrieve returns it per snippet.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore, FakeEmbedder, InMemoryVectorStore } from "@eidentic/types/testing";
import { Memory } from "../src/memory.js";

async function freshStore() {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

const scope = { kind: "agent" as const, agentId: "test-agent" };

describe("Feature 3 — Memory citations: ingest stores metadata, retrieve returns it", () => {
  it("keeps identical event ids isolated across scopes in hot caches", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store, dedupeOnWrite: false });
    const scopeA = { kind: "user" as const, agentId: "a", userId: "tenant-a" };
    const scopeB = { kind: "user" as const, agentId: "a", userId: "tenant-b" };

    await mem.ingest([
      { id: "shared-id", scope: scopeA, text: "alpha private text", metadata: { source: "alpha" } },
      { id: "shared-id", scope: scopeB, text: "beta private text", metadata: { source: "beta" } },
    ]);

    const [exportA, exportB] = await Promise.all([mem.exportScope(scopeA), mem.exportScope(scopeB)]);
    expect(exportA.memories).toEqual([
      expect.objectContaining({ id: "shared-id", text: "alpha private text", metadata: { source: "alpha" } }),
    ]);
    expect(exportB.memories).toEqual([
      expect.objectContaining({ id: "shared-id", text: "beta private text", metadata: { source: "beta" } }),
    ]);
  });

  it("ingest with metadata → retrieve returns metadata on matching snippet (lexical path)", async () => {
    const store = await freshStore();
    const mem = new Memory({ store });

    await mem.ingest([
      {
        id: "doc1:chunk:0",
        scope,
        text: "TypeScript is a typed superset of JavaScript.",
        metadata: { source: "https://typescriptlang.org/docs", page: 1 },
      },
    ]);

    const result = await mem.retrieve({ text: "TypeScript JavaScript", scope });
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.text).toContain("TypeScript");
    // Metadata must be returned on the snippet.
    expect(result.snippets[0]?.metadata).toEqual({ source: "https://typescriptlang.org/docs", page: 1 });
  });

  it("ingest without metadata → retrieve returns snippet without metadata field", async () => {
    const store = await freshStore();
    const mem = new Memory({ store });

    await mem.ingest([
      { id: "plain:0", scope, text: "plain text without metadata" },
    ]);

    const result = await mem.retrieve({ text: "plain text", scope });
    expect(result.snippets).toHaveLength(1);
    // No metadata when event had none.
    expect(result.snippets[0]?.metadata).toBeUndefined();
  });

  it("mixed: some snippets have metadata, others don't → each is correct", async () => {
    const store = await freshStore();
    const mem = new Memory({ store });

    await mem.ingest([
      {
        id: "with-meta",
        scope,
        text: "cherry blossom Japan",
        metadata: { source: "japan-travel-guide" },
      },
      {
        id: "without-meta",
        scope,
        text: "cherry blossom spring festival",
      },
    ]);

    const result = await mem.retrieve({ text: "cherry blossom", scope, topK: 10 });
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);

    const withMeta = result.snippets.find((s) => s.id === "with-meta");
    const withoutMeta = result.snippets.find((s) => s.id === "without-meta");

    if (withMeta) {
      expect(withMeta.metadata).toEqual({ source: "japan-travel-guide" });
    }
    if (withoutMeta) {
      expect(withoutMeta.metadata).toBeUndefined();
    }
  });

  it("metadata with extra custom fields is preserved faithfully", async () => {
    const store = await freshStore();
    const mem = new Memory({ store });

    await mem.ingest([
      {
        id: "custom-meta",
        scope,
        text: "machine learning model evaluation",
        metadata: {
          source: "ml-textbook",
          page: 42,
          chapter: "Model Selection",
          author: "Jane Doe",
        },
      },
    ]);

    const result = await mem.retrieve({ text: "machine learning evaluation", scope });
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    const snippet = result.snippets.find((s) => s.id === "custom-meta");
    expect(snippet?.metadata).toMatchObject({
      source: "ml-textbook",
      page: 42,
      chapter: "Model Selection",
      author: "Jane Doe",
    });
  });

  it("semantic path (vector+embedder): metadata is returned for semantic recall hits", async () => {
    const store = await freshStore();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(16);
    const mem = new Memory({ store, vector, embedder });

    await mem.ingest([
      {
        id: "semantic-meta",
        scope,
        text: "neural networks deep learning",
        metadata: { source: "https://deeplearning.ai" },
      },
    ]);

    const result = await mem.retrieve({ text: "neural deep learning", scope });
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    const snippet = result.snippets.find((s) => s.id === "semantic-meta");
    expect(snippet).toBeDefined();
    expect(snippet?.metadata).toEqual({ source: "https://deeplearning.ai" });
  });

  it("re-ingest with different metadata → metadata is updated to the latest", async () => {
    const store = await freshStore();
    // dedupeOnWrite: false — this test explicitly exercises re-ingest of the same event ID
    // with updated metadata (an intentional upsert, not a duplicate to be suppressed).
    const mem = new Memory({ store, dedupeOnWrite: false });

    // Ingest with original metadata.
    await mem.ingest([
      { id: "reindex-doc", scope, text: "solar system planets", metadata: { source: "old-source" } },
    ]);

    // Re-ingest with updated metadata (same id).
    await mem.ingest([
      { id: "reindex-doc", scope, text: "solar system planets", metadata: { source: "new-source", page: 5 } },
    ]);

    const result = await mem.retrieve({ text: "solar system planets", scope });
    expect(result.snippets.length).toBeGreaterThanOrEqual(1);
    const snippet = result.snippets.find((s) => s.id === "reindex-doc");
    // Latest metadata wins.
    expect(snippet?.metadata?.source).toBe("new-source");
    expect(snippet?.metadata?.page).toBe(5);
  });
});
