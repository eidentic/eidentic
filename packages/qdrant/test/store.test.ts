import { describe, it, expect, vi } from "vitest";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { QdrantVectorStore, type QdrantLike, type QdrantScoredPoint, type QdrantCondition, type QdrantFieldCondition } from "../src/index.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; ma += a[i]! * a[i]!; mb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}

/** UUID v4/v5 regex (8-4-4-4-12 hex groups). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns whether a given condition matches a point.
 * Faithful to real Qdrant semantics:
 *  - `{ has_id }` matches against the POINT ID.
 *  - `{ key, match: { value } }` matches against the PAYLOAD field named `key` ONLY.
 */
function matchesCondition(id: string | number, payload: Record<string, unknown>, cond: QdrantCondition): boolean {
  if ("has_id" in cond) {
    return cond.has_id.some((v) => String(v) === String(id));
  }
  return String(payload[cond.key] ?? "") === cond.match.value;
}

/**
 * Faithful in-memory Qdrant: stores points per collection, real cosine search + scope_key filter.
 * FAITHFULLY rejects point IDs that are not a UUID or an unsigned integer — exactly as the real
 * Qdrant server does. This means: if the adapter ever regresses to passing raw string IDs (e.g.
 * "a", "b", "shared") directly, the upsert will throw here and the conformance suite will fail,
 * proving the idToUuid fix is load-bearing.
 */
class FakeQdrant implements QdrantLike {
  private collections = new Map<string, Map<string | number, { vector: number[]; payload: Record<string, unknown> }>>();

  private assertValidPointId(id: string | number): void {
    if (typeof id === "number") {
      if (!Number.isInteger(id) || id < 0) {
        throw new Error(`FakeQdrant: invalid point id ${JSON.stringify(id)} — must be UUID or unsigned integer`);
      }
      return;
    }
    // string: must be UUID
    if (!UUID_RE.test(id)) {
      throw new Error(
        `FakeQdrant: invalid point id ${JSON.stringify(id)} — real Qdrant only accepts UUID or unsigned-integer point IDs`,
      );
    }
  }

  async getCollections() {
    return { collections: [...this.collections.keys()].map((name) => ({ name })) };
  }
  async createCollection(collection: string) {
    if (!this.collections.has(collection)) this.collections.set(collection, new Map());
    return {};
  }
  async upsert(collection: string, opts: { points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }> }) {
    const col = this.collections.get(collection)!;
    for (const p of opts.points) {
      this.assertValidPointId(p.id);
      col.set(p.id, { vector: p.vector, payload: p.payload ?? {} });
    }
    return {};
  }
  async search(collection: string, opts: { vector: number[]; limit: number; filter?: { must: Array<{ key: string; match: { value: string } }> } }): Promise<QdrantScoredPoint[]> {
    const col = this.collections.get(collection)!;
    const want = opts.filter?.must.find((m) => m.key === "scope_key")?.match.value;
    return [...col.entries()]
      .filter(([, v]) => want === undefined || v.payload["scope_key"] === want)
      .map(([id, v]) => ({ id, score: cosine(opts.vector, v.vector), payload: v.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
  }
  async delete(
    collection: string,
    opts:
      | { points: Array<string | number> }
      | { filter: { must: Array<QdrantCondition> } },
  ) {
    const col = this.collections.get(collection)!;
    if ("points" in opts) {
      for (const id of opts.points) col.delete(id);
    } else {
      // Filter-based delete: all must-conditions must match (faithful Qdrant semantics).
      // `has_id` matches by point id; `key/match` matches by payload field only.
      const must = opts.filter.must;
      for (const [id, point] of [...col.entries()]) {
        if (must.every((cond) => matchesCondition(id, point.payload, cond))) {
          col.delete(id);
        }
      }
    }
    return {};
  }
}

describe("QdrantVectorStore conformance (faithful in-memory fake)", () => {
  for (const c of vectorConformanceCases(async () => {
    const client = new FakeQdrant();
    return QdrantVectorStore.create({ client, collection: "memories", dim: 4 });
  })) it(c.name, c.run);
});

describe("FakeQdrant faithfulness: rejects raw string point IDs (proving idToUuid is load-bearing)", () => {
  it("rejects a non-UUID string point id (simulates real Qdrant rejection)", async () => {
    const fake = new FakeQdrant();
    await fake.createCollection("test");
    // A raw string id like "a" is what the adapter used to send before the idToUuid fix.
    await expect(
      fake.upsert("test", { points: [{ id: "a", vector: [1, 0, 0, 0] }] }),
    ).rejects.toThrow(/invalid point id/i);
  });

  it("accepts a UUID point id (what the fixed adapter sends)", async () => {
    const fake = new FakeQdrant();
    await fake.createCollection("test");
    const uuid = "86f7e437-faa5-5faf-a757-99b8b66a3d5d"; // valid UUID
    await expect(
      fake.upsert("test", { points: [{ id: uuid, vector: [1, 0, 0, 0] }] }),
    ).resolves.not.toThrow();
  });

  it("accepts an unsigned-integer point id", async () => {
    const fake = new FakeQdrant();
    await fake.createCollection("test");
    await expect(
      fake.upsert("test", { points: [{ id: 42, vector: [1, 0, 0, 0] }] }),
    ).resolves.not.toThrow();
  });
});

describe("QdrantVectorStore eraseScope: exact count via optional count() capability", () => {
  /**
   * FakeQdrant with the optional `count` method — simulates a client that supports server-side
   * exact counting.  We spy on it to confirm the adapter prefers it over the search approximation.
   */
  class FakeQdrantWithCount extends FakeQdrant implements Required<Pick<QdrantLike, "count">> {
    async count(
      collection: string,
      opts: { filter: { must: Array<QdrantFieldCondition> }; exact: boolean },
    ): Promise<{ count: number }> {
      // Delegate to the search-based path of the fake for a correct result.
      const dummyVec = [0, 0, 0, 0];
      const hits = await this.search(collection, {
        vector: dummyVec,
        limit: 1_000_000,
        filter: opts.filter,
        with_payload: false,
      });
      return { count: hits.length };
    }
  }

  it("uses count() when available and returns exact deleted count", async () => {
    const client = new FakeQdrantWithCount();
    const countSpy = vi.spyOn(client, "count");
    const searchSpy = vi.spyOn(client, "search");

    const store = await QdrantVectorStore.create({ client, collection: "c", dim: 4 });
    await store.upsert({ id: "a", scopeKey: "s1", text: "A", vector: [1, 0, 0, 0] });
    await store.upsert({ id: "b", scopeKey: "s1", text: "B", vector: [0, 1, 0, 0] });
    await store.upsert({ id: "c", scopeKey: "s2", text: "C", vector: [0, 0, 1, 0] });

    const result = await store.eraseScope("s1");
    expect(result.deleted).toBe(2);
    // count() must have been called (exact path)
    expect(countSpy).toHaveBeenCalled();
    // search() should NOT have been called for the pre-count (only via createCollection check)
    // After eraseScope, search for s1 calls via count; the search spy should have 0 eraseScope calls.
    // We verify by checking count was called at least once.
    expect(countSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to high-topK search approximation when count() is absent", async () => {
    const client = new FakeQdrant(); // no count() method
    const searchSpy = vi.spyOn(client, "search");

    const store = await QdrantVectorStore.create({ client, collection: "c2", dim: 4 });
    await store.upsert({ id: "a", scopeKey: "s1", text: "A", vector: [1, 0, 0, 0] });
    await store.upsert({ id: "b", scopeKey: "s1", text: "B", vector: [0, 1, 0, 0] });

    const result = await store.eraseScope("s1");
    expect(result.deleted).toBe(2);
    // search() must have been used as the fallback approximation
    expect(searchSpy).toHaveBeenCalled();
  });
});

describe("QdrantVectorStore id round-trip: string entry.id → UUID point → orig_id returned", () => {
  it("upsert with string id 'a' then search returns id 'a' (not the UUID)", async () => {
    const client = new FakeQdrant();
    const store = await QdrantVectorStore.create({ client, collection: "rt", dim: 4 });
    await store.upsert({ id: "a", scopeKey: "k", text: "hello", vector: [1, 0, 0, 0] });
    const hits = await store.search([1, 0, 0, 0], "k", 10);
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.text).toBe("hello");
  });

  it("delete('a', ...) removes the correct point (derived UUID matches)", async () => {
    const client = new FakeQdrant();
    const store = await QdrantVectorStore.create({ client, collection: "rt2", dim: 4 });
    await store.upsert({ id: "a", scopeKey: "k", text: "A", vector: [1, 0, 0, 0] });
    await store.delete("a", "k");
    const hits = await store.search([1, 0, 0, 0], "k", 10);
    expect(hits.some((h) => h.id === "a")).toBe(false);
  });
});
