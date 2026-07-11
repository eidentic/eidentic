import { describe, it, expect, vi } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import { legacyScopeKey, scopeKey, type Scope, type RerankPort, type EmbeddingPort } from "@eidentic/types";
import { Memory, migrateLegacyScopeVectors } from "../src/memory.js";
import { reciprocalRankFusion } from "../src/rrf.js";
import { editableMemoryCases } from "./_editable-cases.js";

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };

describe("migrateLegacyScopeVectors", () => {
  const ambiguous: Scope = { kind: "user", agentId: "acme:west", userId: "alice" };

  it("requires an empty target and moves the exact legacy vector set", async () => {
    const vector = new InMemoryVectorStore();
    await vector.upsert({ id: "m1", scopeKey: legacyScopeKey(ambiguous), text: "legacy", vector: [1, 0] });
    await expect(migrateLegacyScopeVectors(vector, ambiguous)).resolves.toEqual({ migrated: 1 });
    await expect(vector.list(legacyScopeKey(ambiguous))).resolves.toEqual([]);
    await expect(vector.list(scopeKey(ambiguous))).resolves.toMatchObject([{ id: "m1", text: "legacy" }]);
  });

  it("refuses unrelated target data but resumes an identical partial copy", async () => {
    const vector = new InMemoryVectorStore();
    await vector.upsert({ id: "old", scopeKey: legacyScopeKey(ambiguous), text: "old", vector: [1, 0] });
    await vector.upsert({ id: "new", scopeKey: scopeKey(ambiguous), text: "new", vector: [0, 1] });
    await expect(migrateLegacyScopeVectors(vector, ambiguous)).rejects.toThrow(/unrelated data/i);
    await expect(vector.list(legacyScopeKey(ambiguous))).resolves.toHaveLength(1);

    const resumed = new InMemoryVectorStore();
    const old = { id: "old", text: "old", vector: [1, 0] };
    await resumed.upsert({ ...old, scopeKey: legacyScopeKey(ambiguous) });
    await resumed.upsert({ ...old, scopeKey: scopeKey(ambiguous) });
    await expect(migrateLegacyScopeVectors(resumed, ambiguous)).resolves.toEqual({ migrated: 1 });
    await expect(resumed.list(legacyScopeKey(ambiguous))).resolves.toEqual([]);
  });
});

describe("reciprocalRankFusion", () => {
  it("fuses ranked lists; a single list preserves order", () => {
    const out = reciprocalRankFusion([[
      { id: "a", text: "A", score: 9 },
      { id: "b", text: "B", score: 3 },
    ]]);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });
  it("boosts items appearing in multiple lists", () => {
    const out = reciprocalRankFusion([
      [{ id: "x", text: "X", score: 1 }, { id: "y", text: "Y", score: 1 }],
      [{ id: "y", text: "Y", score: 1 }, { id: "z", text: "Z", score: 1 }],
    ]);
    expect(out[0]!.id).toBe("y"); // appears in both → top
  });
});

describe("Memory (lexical)", () => {
  it("getAlwaysInContext returns the scope's blocks", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.upsertBlock(scope, { label: "human", value: "name: Baran" });
    const mem = new Memory({ store });
    const blocks = await mem.getAlwaysInContext(scope);
    expect(blocks.map((b) => b.label)).toEqual(["human"]);
  });

  it("ingest then retrieve recalls relevant snippets", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });
    await mem.ingest([
      { id: "e1", scope, text: "Baran prefers TypeScript and pnpm" },
      { id: "e2", scope, text: "the weather is sunny" },
    ]);
    const { snippets } = await mem.retrieve({ text: "what language does Baran prefer", scope });
    expect(snippets[0]!.id).toBe("e1");
  });
});

describe("Memory (semantic)", () => {
  it("ingest dual-writes (lexical + vector) and retrieve fuses both signals", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(16);
    const mem = new Memory({ store, vector, embedder });

    await mem.ingest([
      { id: "e1", scope, text: "Baran prefers TypeScript and pnpm" },
      { id: "e2", scope, text: "the weather is sunny today" },
    ]);
    // lexical index populated:
    expect((await store.searchMemory(scope, "TypeScript", 10)).some((h) => h.id === "e1")).toBe(true);
    // vector index populated + retrieve returns the relevant snippet first:
    const { snippets } = await mem.retrieve({ text: "what does Baran prefer typescript pnpm", scope });
    expect(snippets[0]!.id).toBe("e1");
  });

  it("applies a reranker when provided", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const mem = new Memory({
      store, vector: new InMemoryVectorStore(), embedder: new FakeEmbedder(16),
      // reranker that forces e2 to the top regardless of fusion
      reranker: { rerank: async (_q, c) => [...c].sort((a, b) => (a.id === "e2" ? -1 : 1)) } as RerankPort,
    });
    await mem.ingest([
      { id: "e1", scope, text: "alpha beta" },
      { id: "e2", scope, text: "gamma delta" },
    ]);
    const { snippets } = await mem.retrieve({ text: "alpha beta gamma", scope });
    expect(snippets[0]!.id).toBe("e2"); // reranker had the final say
  });
});

describe("Memory construction validation", () => {
  it("throws when vector is provided without embedder", () => {
    const store = new InMemoryStore();
    expect(() => new Memory({ store, vector: new InMemoryVectorStore() })).toThrow(/together/);
  });

  it("throws when embedder is provided without vector", () => {
    const store = new InMemoryStore();
    expect(() => new Memory({ store, embedder: new FakeEmbedder(16) })).toThrow(/together/);
  });

  it("throws when reranker is provided without vector+embedder", () => {
    const store = new InMemoryStore();
    const reranker: RerankPort = { rerank: async (_q, c) => c };
    expect(() => new Memory({ store, reranker })).toThrow(/reranker/);
  });
});

describe("Memory (lexical) editable parity", () => {
  for (const c of editableMemoryCases(() => {
    const store = new InMemoryStore();
    void store.migrate();
    const memory = new Memory({
      store,
      blocks: {
        human: { value: "", description: "facts about the user", limit: 20 },
        persona: { value: "I am helpful.", readOnly: true },
      },
      newId: ((n) => () => `arc${n++}`)(0),
    });
    return { memory, store };
  })) it(c.name, c.run);
});

describe("Memory (semantic) editable parity", () => {
  for (const c of editableMemoryCases(() => {
    const store = new InMemoryStore();
    void store.migrate();
    const memory = new Memory({
      store,
      vector: new InMemoryVectorStore(),
      embedder: new FakeEmbedder(16),
      blocks: {
        human: { value: "", description: "facts about the user", limit: 20 },
        persona: { value: "I am helpful.", readOnly: true },
      },
      newId: ((n) => () => `arc${n++}`)(0),
    });
    return { memory, store };
  })) it(c.name, c.run);
});

describe("Memory.ingest embedBatch (Fix 4)", () => {
  it("calls embedBatch ONCE for N events when embedder supports it", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();

    // Build a fake embedder WITH embedBatch, using a spy to count calls.
    const base = new FakeEmbedder(16);
    const batchSpy = vi.fn(async (texts: string[]) => Promise.all(texts.map((t) => base.embed(t))));
    const batchEmbedder: EmbeddingPort = {
      dim: 16,
      embed: (t) => base.embed(t),
      embedBatch: batchSpy,
    };

    const mem = new Memory({ store, vector, embedder: batchEmbedder });
    await mem.ingest([
      { id: "e1", scope, text: "alpha beta" },
      { id: "e2", scope, text: "gamma delta" },
      { id: "e3", scope, text: "epsilon zeta" },
    ]);

    // embedBatch called exactly ONCE (not 3 times)
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0]![0]).toEqual(["alpha beta", "gamma delta", "epsilon zeta"]);

    // Recall still works correctly end-to-end
    const { snippets } = await mem.retrieve({ text: "gamma delta", scope });
    expect(snippets[0]!.id).toBe("e2");
  });

  it("falls back to per-item embed when embedBatch is absent", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();

    const base = new FakeEmbedder(16);
    const embedSpy = vi.fn((t: string) => base.embed(t));
    const singleEmbedder: EmbeddingPort = {
      dim: 16,
      embed: embedSpy,
      // No embedBatch
    };

    const mem = new Memory({ store, vector, embedder: singleEmbedder });
    await mem.ingest([
      { id: "e1", scope, text: "alpha beta" },
      { id: "e2", scope, text: "gamma delta" },
    ]);

    // embed called twice (once per event) — fallback path
    expect(embedSpy).toHaveBeenCalledTimes(2);

    // Recall still works
    const { snippets } = await mem.retrieve({ text: "alpha", scope });
    expect(snippets[0]!.id).toBe("e1");
  });
});

describe("Memory (graph)", () => {
  const gScope: Scope = { kind: "user", agentId: "g", userId: "u" };

  it("assertFact/queryFacts delegate to the configured graph", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store, graph: store });
    const r = await mem.assertFact(gScope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: "2026-01-01T00:00:00.000Z" });
    expect(r.asserted.object).toBe("TypeScript");
    const hits = await mem.queryFacts({ scope: gScope, subject: "Baran" });
    expect(hits.map((f) => f.object)).toEqual(["TypeScript"]);
  });

  it("assertFact/queryFacts throw a clear error when no graph is configured", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });
    await expect(mem.assertFact(gScope, { subject: "a", predicate: "b", object: "c" })).rejects.toThrow(/graph/i);
    await expect(mem.queryFacts({ scope: gScope })).rejects.toThrow(/graph/i);
  });

  it("retrieve folds matching currently-valid facts into recall as an entity signal", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store, graph: store });
    await mem.assertFact(gScope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: "2026-01-01T00:00:00.000Z" });
    const out = await mem.retrieve({ text: "what is Baran's favorite_language", scope: gScope, topK: 8 });
    expect(out.snippets.some((s) => s.text.includes("Baran") && s.text.includes("TypeScript"))).toBe(true);
  });

  it("retrieve without a graph behaves exactly like lexical-only (no entity snippets)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });
    await mem.ingest([{ id: "m1", scope: gScope, text: "alpha beta" }]);
    const out = await mem.retrieve({ text: "alpha", scope: gScope, topK: 8 });
    expect(out.snippets.map((s) => s.id)).toEqual(["m1"]);
  });
});

// ─── A4: Memory.eraseScope includes graph when separately-injected GraphPort supports it ──

describe("A4 — Memory.eraseScope covers separately-injected GraphPort", () => {
  const eraseScope: Scope = { kind: "user", agentId: "ag-erase", userId: "u-erase" };

  it("calls graph.eraseScope when graph has the method and returns its deleted count", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    let graphEraseCalled = false;
    const fakeGraph = {
      assertFact: async () => { throw new Error("not used"); },
      queryFacts: async () => [],
      eraseScope: async (_scope: Scope) => {
        graphEraseCalled = true;
        return { deleted: 42 };
      },
    };

    const mem = new Memory({ store, graph: fakeGraph as any });
    const result = await mem.eraseScope(eraseScope);

    expect(graphEraseCalled).toBe(true);
    expect(result.graph).toBe(42);
  });

  it("does NOT call graph.eraseScope when graph lacks the method (backward-compatible)", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    let executeCalled = false;
    // Minimal GraphPort without eraseScope (pre-A4 adapter).
    const legacyGraph = {
      assertFact: async () => { executeCalled = true; return {} as any; },
      queryFacts: async () => [],
      // No eraseScope method at all.
    };

    const mem = new Memory({ store, graph: legacyGraph as any });
    const result = await mem.eraseScope(eraseScope);

    expect(executeCalled).toBe(false); // assertFact was not called
    expect(result.graph).toBe(0); // no graph deletion reported
  });

  it("returns graph:0 when no graph is configured", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });
    const result = await mem.eraseScope(eraseScope);
    expect(result.graph).toBe(0);
  });

  it("when graph IS the same InMemoryStore, eraseScope on both is harmless (zero double-count)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Insert a fact so there is something to erase.
    await store.assertFact(eraseScope, { subject: "X", predicate: "p", object: "Y", validFrom: "2026-01-01T00:00:00.000Z" });

    const mem = new Memory({ store, graph: store });
    const result = await mem.eraseScope(eraseScope);

    // store count ≥ 1 (fact row), graph count may be 0 (already erased by store pass) or also ≥ 1.
    // The key property: combined result never throws and graph field is a non-negative integer.
    expect(result.graph).toBeGreaterThanOrEqual(0);
    expect(typeof result.store).toBe("number");

    // Facts must be gone.
    const facts = await store.queryFacts({ scope: eraseScope });
    expect(facts.length).toBe(0);
  });
});

// ─── eraseScope clears in-memory metadata/ingestedAt maps ──────────────────────────────────────

describe("Memory.eraseScope — in-memory map clearing", () => {
  const scopeA: Scope = { kind: "user", agentId: "ag-maps", userId: "u-alice" };
  const scopeB: Scope = { kind: "user", agentId: "ag-maps", userId: "u-bob" };

  it("clears metadataStore entries for the erased scope (metadata no longer returned)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });

    // Ingest event with metadata for scope A
    await mem.ingest([
      {
        id: "evt-meta-1",
        scope: scopeA,
        text: "alice prefers dark mode",
        metadata: { source: "chat", page: 1 },
      },
    ]);

    // Confirm metadata is returned before erase
    const before = await mem.retrieve({ text: "alice", scope: scopeA });
    const withMeta = before.snippets.find((s) => s.id === "evt-meta-1");
    expect(withMeta?.metadata).toEqual({ source: "chat", page: 1 });

    // Erase scope A
    await mem.eraseScope(scopeA);

    // After erase, retrieve returns nothing (store erased, no FTS rows remain)
    const after = await mem.retrieve({ text: "alice", scope: scopeA });
    expect(after.snippets.length).toBe(0);
  });

  it("clears ingestedAtStore entries for the erased scope", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    let tick = 1_000_000;
    const mem = new Memory({ store, now: () => new Date(tick).toISOString() });

    await mem.ingest([{ id: "evt-ts-1", scope: scopeA, text: "alice likes coffee" }]);
    tick += 60_000; // advance clock so recency matters

    // Erase scope A — should clear ingestedAtStore
    await mem.eraseScope(scopeA);

    // Re-ingest the same id under scope A: after erase the metadataStore and ingestedAtStore are clear
    await mem.ingest([{ id: "evt-ts-1", scope: scopeA, text: "alice likes tea now" }]);
    const after = await mem.retrieve({ text: "alice", scope: scopeA });
    // After re-ingest, retrieve works correctly — no stale timestamp
    expect(after.snippets.some((s) => s.id === "evt-ts-1")).toBe(true);
  });

  it("cross-scope isolation: erasing scope A leaves scope B metadata intact", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });

    await mem.ingest([
      { id: "a-evt", scope: scopeA, text: "alice topic", metadata: { source: "a-doc" } },
      { id: "b-evt", scope: scopeB, text: "bob topic", metadata: { source: "b-doc" } },
    ]);

    // Erase only scope A
    await mem.eraseScope(scopeA);

    // Scope B's memory must still be retrievable with its metadata
    const bobResult = await mem.retrieve({ text: "bob", scope: scopeB });
    const bobSnippet = bobResult.snippets.find((s) => s.id === "b-evt");
    expect(bobSnippet).toBeDefined();
    expect(bobSnippet?.metadata).toEqual({ source: "b-doc" });

    // Scope A's memory must be gone
    const aliceResult = await mem.retrieve({ text: "alice", scope: scopeA });
    expect(aliceResult.snippets.length).toBe(0);
  });

  it("idempotent: erasing an already-erased scope is a no-op success", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const mem = new Memory({ store });

    await mem.ingest([{ id: "idem-1", scope: scopeA, text: "idempotent test" }]);
    await mem.eraseScope(scopeA);

    // Second erase must not throw and must report 0 deleted
    const second = await mem.eraseScope(scopeA);
    expect(second.store).toBe(0);
    expect(second.vector).toBe(0);
    expect(second.graph).toBe(0);
  });
});
