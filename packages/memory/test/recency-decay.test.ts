/**
 * Recency-decay ranking tests for Memory.retrieve.
 *
 * Strategy:
 *   - Inject a controlled clock so age calculations are deterministic.
 *   - Use FakeEmbedder + InMemoryVectorStore for the semantic path but the real focus
 *     is on the re-ranking that happens AFTER retrieval, so we also test on the lexical
 *     path with InMemoryStore alone (no vector/embedder needed).
 *   - We insert memories at simulated "past" times and query at a fixed "now", then assert
 *     that recency-enabled retrieve re-orders newer-first.
 *
 * Note on RRF tie-breaking: when multiple snippets have identical lexical scores, RRF breaks
 * ties by insertion order, yielding subtly different normalized-similarity values. Tests that
 * assert recency overrides similarity therefore need weight values high enough that the recency
 * delta dominates those small tie-breaking differences. Each test documents the weight chosen.
 *
 * Clock convention: the `now` injectable is called once at ingest time (per ingest call) and
 * once per retrieve call. We advance a single mutable variable between ingest and retrieve to
 * simulate the passage of time.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";
import { Memory } from "../src/memory.js";

const scope: Scope = { kind: "agent", agentId: "recency-test" };

// ─── helper ──────────────────────────────────────────────────────────────────

/**
 * Build a mutable clock. Update `.current` before the next call to advance time.
 */
function makeClock(initial: string): { (): string; current: string } {
  const fn = () => fn.current;
  fn.current = initial;
  return fn;
}

// ─── 1. without recency config: ordering is unchanged (backward compat) ──────

describe("Memory.retrieve without recency — backward-compatible ordering", () => {
  it("ordering matches pure similarity; recency config absent → no re-ranking", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    const mem = new Memory({ store, now: clock });

    // Ingest two entries whose text makes e-old a stronger lexical match for the query.
    clock.current = "2026-01-01T00:00:00.000Z"; // old
    await mem.ingest([{ id: "e-old", scope, text: "typescript pnpm monorepo" }]);

    clock.current = "2026-06-01T00:00:00.000Z"; // newer, but weak match
    await mem.ingest([{ id: "e-new", scope, text: "sunny weather today" }]);

    clock.current = "2026-06-09T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text: "typescript pnpm", scope, topK: 8 });

    // Without recency config the lexically-stronger match (e-old) stays first.
    expect(snippets[0]?.id).toBe("e-old");
  });

  it("weight: 0 has no effect on ordering (explicit zero weight)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    // weight: 0 → recency contributes nothing → pure similarity order preserved.
    const mem = new Memory({ store, now: clock, recency: { halfLifeMs: 1, weight: 0 } });

    clock.current = "2026-01-01T00:00:00.000Z";
    await mem.ingest([{ id: "e-old", scope, text: "typescript pnpm monorepo" }]);

    clock.current = "2026-06-01T00:00:00.000Z";
    await mem.ingest([{ id: "e-new", scope, text: "sunny weather today" }]);

    clock.current = "2026-06-09T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text: "typescript pnpm", scope, topK: 8 });

    // weight=0: similarity-only, same as having no recency config.
    expect(snippets[0]?.id).toBe("e-old");
  });
});

// ─── 2. with recency enabled: newer memories rank higher ─────────────────────

describe("Memory.retrieve with recency — newer memories bubble up", () => {
  it("re-orders newer-first when recency dominates (high weight + large age gap)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // Use weight=0.9 so recency strongly dominates any RRF tie-breaking differences.
    // Half-life 30 days makes the 5-month age gap very decisive.
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    // dedupeOnWrite: false — this test intentionally ingests identical text at different
    // times (different IDs) to exercise recency decay ordering. That is not a production
    // duplicate; it is the test fixture for the recency feature.
    const mem = new Memory({ store, now: clock, recency: { halfLifeMs, weight: 0.9 }, dedupeOnWrite: false });

    // Ingest three entries with IDENTICAL text (so retrieval scores differ only via RRF
    // tie-breaking). Age differences drive the re-ranking via the high recency weight.
    const text = "machine learning neural networks";

    clock.current = "2026-01-01T00:00:00.000Z"; // ~159 days old at query time
    await mem.ingest([{ id: "old", scope, text }]);

    clock.current = "2026-04-01T00:00:00.000Z"; // ~69 days old at query time
    await mem.ingest([{ id: "mid", scope, text }]);

    clock.current = "2026-06-08T00:00:00.000Z"; // 1 day old at query time
    await mem.ingest([{ id: "new", scope, text }]);

    // Query at "now" (2026-06-09).
    clock.current = "2026-06-09T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text, scope, topK: 8 });

    const ids = snippets.map((s) => s.id);
    // Newest must be first.
    expect(ids[0]).toBe("new");
    // Middle must come before the oldest.
    const midIdx = ids.indexOf("mid");
    const oldIdx = ids.indexOf("old");
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it("very short half-life makes recency dominate over similarity", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // 10-second half-life: after 1 minute the recency factor is negligible (~2e-4).
    // Note: recency re-ranks within the retrieved set — both entries must have lexical overlap
    // with the query so they both appear as candidates, then recency reorders them.
    const halfLifeMs = 10_000;
    const mem = new Memory({ store, now: clock, recency: { halfLifeMs, weight: 0.9 } });

    // Both entries match the query ("typescript pnpm"), but old-strong is a stronger BM25 match.
    const strongMatchText = "typescript pnpm monorepo build tool excellent";
    const weakMatchText   = "typescript language weakly pnpm mentioned once";

    // Old entry ingested 10 minutes ago (very stale for a 10-second half-life).
    const tenMinutesAgoMs = Date.parse("2026-06-09T12:00:00.000Z") - 10 * 60 * 1000;
    clock.current = new Date(tenMinutesAgoMs).toISOString();
    await mem.ingest([{ id: "old-strong", scope, text: strongMatchText }]);

    // New entry ingested 1 second ago (essentially fresh: recency factor ≈ 0.933).
    const oneSecondAgoMs = Date.parse("2026-06-09T12:00:00.000Z") - 1_000;
    clock.current = new Date(oneSecondAgoMs).toISOString();
    await mem.ingest([{ id: "new-weak", scope, text: weakMatchText }]);

    // Query with text that strongly matches old-strong but both entries still appear.
    clock.current = "2026-06-09T12:00:00.000Z";
    const { snippets } = await mem.retrieve({ text: "typescript pnpm monorepo", scope, topK: 8 });

    // Verify both candidates were retrieved (so re-ranking happened across them).
    expect(snippets.map((s) => s.id)).toContain("old-strong");
    expect(snippets.map((s) => s.id)).toContain("new-weak");

    // With halfLifeMs=10s: after 10 min, recency ≈ 0; after 1 s, recency ≈ 0.933.
    // At weight=0.9: new-weak gets ≈ 0.9 * 0.933 ≈ 0.84; old-strong gets ≈ 0.1 * 1 + 0.9 * 0 = 0.10.
    // Despite being lexically weaker, new-weak must rank first.
    expect(snippets[0]?.id).toBe("new-weak");
  });

  it("semantic path (vector+embedder): recency re-ranking works end-to-end", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(16);
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // weight=0.9 so recency decisively overrides any RRF tie-breaking from identical text.
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    // dedupeOnWrite: false — identical text at different times, different IDs (recency fixture)
    const mem = new Memory({ store, vector, embedder, now: clock, recency: { halfLifeMs, weight: 0.9 }, dedupeOnWrite: false });

    const text = "deep learning transformer architecture";

    clock.current = "2026-01-01T00:00:00.000Z"; // ~159 days old
    await mem.ingest([{ id: "sem-old", scope, text }]);

    clock.current = "2026-06-08T00:00:00.000Z"; // 1 day old
    await mem.ingest([{ id: "sem-new", scope, text }]);

    clock.current = "2026-06-09T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text, scope, topK: 8 });

    // With weight=0.9: sem-new (1 day old, recency ≈ 0.977) decisively beats sem-old (159 days old).
    expect(snippets[0]?.id).toBe("sem-new");
  });
});

// ─── 3. metadata is preserved after recency re-ranking ───────────────────────

describe("Memory.retrieve with recency — metadata still attached", () => {
  it("metadata survives recency re-ranking", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // weight=0.9 to ensure the newer entry wins despite any tie-breaking.
    // dedupeOnWrite: false — identical text at different times, different IDs (recency fixture)
    const mem = new Memory({
      store,
      now: clock,
      recency: { halfLifeMs: 30 * 24 * 60 * 60 * 1000, weight: 0.9 },
      dedupeOnWrite: false,
    });

    clock.current = "2026-01-01T00:00:00.000Z"; // ~159 days old
    await mem.ingest([
      {
        id: "meta-old",
        scope,
        text: "python data science pandas numpy",
        metadata: { source: "old-source", page: 1 },
      },
    ]);

    clock.current = "2026-06-08T00:00:00.000Z"; // 1 day old
    await mem.ingest([
      {
        id: "meta-new",
        scope,
        text: "python data science pandas numpy",
        metadata: { source: "new-source", page: 2 },
      },
    ]);

    clock.current = "2026-06-09T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text: "python data science", scope, topK: 8 });

    // Newest first due to recency weight=0.9.
    expect(snippets[0]?.id).toBe("meta-new");
    expect(snippets[0]?.metadata).toEqual({ source: "new-source", page: 2 });

    const old = snippets.find((s) => s.id === "meta-old");
    expect(old?.metadata).toEqual({ source: "old-source", page: 1 });
  });
});

// ─── 4. edge cases ────────────────────────────────────────────────────────────

describe("Memory.retrieve with recency — edge cases", () => {
  it("single snippet: no error, snippet returned", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    const mem = new Memory({ store, now: clock, recency: { halfLifeMs: 86_400_000 } });

    await mem.ingest([{ id: "only", scope, text: "unique content" }]);

    clock.current = "2026-01-02T00:00:00.000Z";
    const { snippets } = await mem.retrieve({ text: "unique content", scope, topK: 8 });

    expect(snippets).toHaveLength(1);
    expect(snippets[0]?.id).toBe("only");
  });

  it("score stored on returned snippets is the combined blended score (not raw similarity)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    // weight: 1 → score = recency factor only; age=0 → recency factor = 1 → score = 1.
    const mem = new Memory({ store, now: clock, recency: { halfLifeMs: 86_400_000, weight: 1 } });

    await mem.ingest([{ id: "e1", scope, text: "something interesting" }]);
    // Query immediately (age ≈ 0 since clock hasn't advanced).
    const { snippets } = await mem.retrieve({ text: "something interesting", scope, topK: 8 });

    expect(snippets[0]?.id).toBe("e1");
    // At age = 0 with weight=1: combined score = exp(0) = 1.
    expect(snippets[0]!.score).toBeCloseTo(1, 5);
  });

  it("weight: 0 returns same ordering as no recency (asserts backward compat numerically)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // Build two Memory instances: one without recency, one with weight=0.
    const memNoRecency = new Memory({ store, now: clock });
    // The second instance shares the same store — it will also see both ingested entries.

    await memNoRecency.ingest([
      { id: "a", scope, text: "alpha beta gamma language model" },
      { id: "b", scope, text: "delta epsilon neural transformer" },
    ]);

    const { snippets: baseSnippets } = await memNoRecency.retrieve({ text: "language model transformer", scope, topK: 8 });

    // Now build a new Memory instance with weight=0 over a fresh store.
    const store2 = new InMemoryStore();
    await store2.migrate();
    const memWeightZero = new Memory({ store: store2, now: clock, recency: { halfLifeMs: 1000, weight: 0 } });
    await memWeightZero.ingest([
      { id: "a", scope, text: "alpha beta gamma language model" },
      { id: "b", scope, text: "delta epsilon neural transformer" },
    ]);
    const { snippets: zeroSnippets } = await memWeightZero.retrieve({ text: "language model transformer", scope, topK: 8 });

    // Same ordering as no-recency.
    expect(zeroSnippets.map((s) => s.id)).toEqual(baseSnippets.map((s) => s.id));
  });
});
