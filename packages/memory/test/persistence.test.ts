/**
 * Persistence tests for ingestedAt timestamps and provenance metadata.
 *
 * These tests verify that:
 *   1. After a simulated "restart" (new Memory instance over the same store),
 *      recency-decay ordering still works correctly because ingestedAt timestamps
 *      survive in the store.
 *   2. Citation metadata (provenance) also survives a restart.
 *   3. A fresh Memory with no prior ingest history (similarity-only control)
 *      produces a different ordering than the restarted instance, confirming
 *      that the persisted timestamps are actually driving the recency ranking.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";
import { Memory } from "../src/memory.js";

const scope: Scope = { kind: "agent", agentId: "persist-test" };

function makeClock(initial: string): { (): string; current: string } {
  const fn = () => fn.current;
  fn.current = initial;
  return fn;
}

describe("Memory persistence — ingestedAt and metadata survive a simulated restart", () => {
  it("recency-decay ordering is preserved after restart (new Memory over same store)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    // --- Phase 1: ingest with a controlled clock ---
    const halfLifeMs = 30 * 24 * 60 * 60 * 1000; // 30 days

    // dedupeOnWrite: false — this test intentionally ingests identical text at different
    // times with different IDs to test that recency timestamps survive a simulated restart.
    const mem1 = new Memory({
      store,
      now: clock,
      recency: { halfLifeMs, weight: 0.9 },
      dedupeOnWrite: false,
    });

    const text = "machine learning neural networks";

    clock.current = "2026-01-01T00:00:00.000Z"; // ~159 days before query time
    await mem1.ingest([{ id: "old", scope, text }]);

    clock.current = "2026-06-08T00:00:00.000Z"; // 1 day before query time
    await mem1.ingest([{ id: "new", scope, text }]);

    // --- Phase 2: simulate restart — new Memory instance, SAME store ---
    // The new instance has empty in-memory maps (ingestedAtStore, metadataStore).
    // Recency decay must still work using values persisted through indexMemory.
    clock.current = "2026-06-09T00:00:00.000Z"; // query time

    const mem2 = new Memory({
      store,      // same backing store
      now: clock, // same injectable clock for the retrieve call
      recency: { halfLifeMs, weight: 0.9 },
    });

    const { snippets } = await mem2.retrieve({ text, scope, topK: 8 });

    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("new");
    expect(ids).toContain("old");

    // Newest entry must rank first despite the new instance having no in-memory cache.
    expect(ids[0]).toBe("new");

    // Confirm the "old" entry is ranked lower (index further in the result).
    expect(ids.indexOf("new")).toBeLessThan(ids.indexOf("old"));
  });

  it("ordering after restart differs from similarity-only (proving persisted timestamps drive ranking)", async () => {
    // Control: a fresh store with no ingestedAt data → similarity-only ordering.
    // Both "old-strong" (stronger lexical match) and "new-weak" (weaker lexical match)
    // are ingested. Without recency the stronger match wins.
    const controlStore = new InMemoryStore();
    await controlStore.migrate();
    const controlClock = makeClock("2026-06-09T00:00:00.000Z");
    const controlMem = new Memory({ store: controlStore, now: controlClock });
    await controlMem.ingest([
      { id: "old-strong", scope, text: "typescript pnpm monorepo build tool excellent" },
      { id: "new-weak",   scope, text: "typescript language weakly pnpm mentioned once" },
    ]);
    const { snippets: controlSnippets } = await controlMem.retrieve({
      text: "typescript pnpm monorepo",
      scope,
      topK: 8,
    });
    // Without recency, the stronger match (old-strong) should win.
    expect(controlSnippets[0]?.id).toBe("old-strong");

    // Experiment: ingest at specific past times so recency can override similarity.
    const halfLifeMs = 10_000; // 10-second half-life: anything > 1 minute is essentially zero.
    const expStore = new InMemoryStore();
    await expStore.migrate();
    const expClock = makeClock("2026-01-01T00:00:00.000Z");

    const mem1 = new Memory({ store: expStore, now: expClock, recency: { halfLifeMs, weight: 0.9 } });

    // old-strong ingested 10 minutes before the query (very stale for a 10s half-life).
    const tenMinAgoMs = Date.parse("2026-06-09T12:00:00.000Z") - 10 * 60 * 1000;
    expClock.current = new Date(tenMinAgoMs).toISOString();
    await mem1.ingest([{ id: "old-strong", scope, text: "typescript pnpm monorepo build tool excellent" }]);

    // new-weak ingested 1 second before the query (essentially fresh).
    const oneSecAgoMs = Date.parse("2026-06-09T12:00:00.000Z") - 1000;
    expClock.current = new Date(oneSecAgoMs).toISOString();
    await mem1.ingest([{ id: "new-weak", scope, text: "typescript language weakly pnpm mentioned once" }]);

    // Simulate restart: new Memory instance, same store.
    expClock.current = "2026-06-09T12:00:00.000Z"; // query time
    const mem2 = new Memory({ store: expStore, now: expClock, recency: { halfLifeMs, weight: 0.9 } });

    const { snippets } = await mem2.retrieve({
      text: "typescript pnpm monorepo",
      scope,
      topK: 8,
    });

    // With persisted timestamps + short half-life: new-weak (fresh) beats old-strong (stale).
    expect(snippets.map((s) => s.id)).toContain("new-weak");
    expect(snippets.map((s) => s.id)).toContain("old-strong");
    expect(snippets[0]?.id).toBe("new-weak");
  });

  it("provenance metadata survives a simulated restart", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    const mem1 = new Memory({ store, now: clock });

    await mem1.ingest([
      {
        id: "cited-doc",
        scope,
        text: "TypeScript is a typed superset of JavaScript",
        metadata: { source: "https://typescriptlang.org/docs", page: 7, chapter: "Types" },
      },
    ]);

    // Simulate restart: new Memory instance over the same store.
    const mem2 = new Memory({ store, now: clock });

    const { snippets } = await mem2.retrieve({ text: "TypeScript JavaScript", scope });

    expect(snippets.length).toBeGreaterThanOrEqual(1);
    const snippet = snippets.find((s) => s.id === "cited-doc");
    expect(snippet).toBeDefined();
    // Metadata must be present after restart — not lost because in-memory maps are empty.
    expect(snippet?.metadata).toEqual({
      source: "https://typescriptlang.org/docs",
      page: 7,
      chapter: "Types",
    });
  });

  it("entry without metadata returns no metadata field after restart", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const clock = makeClock("2026-01-01T00:00:00.000Z");

    const mem1 = new Memory({ store, now: clock });
    await mem1.ingest([{ id: "no-meta", scope, text: "plain text without any metadata" }]);

    // Simulate restart.
    const mem2 = new Memory({ store, now: clock });
    const { snippets } = await mem2.retrieve({ text: "plain text", scope });

    expect(snippets.length).toBeGreaterThanOrEqual(1);
    const snippet = snippets.find((s) => s.id === "no-meta");
    expect(snippet).toBeDefined();
    expect(snippet?.metadata).toBeUndefined();
  });
});
