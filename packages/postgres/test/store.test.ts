import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { storeConformanceCases, durableConformanceCases } from "@eidentic/types/testing";
import { PostgresStore } from "../src/index.js";

// Regression: all-stop-word FTS queries must not crash (to_tsquery raised on empty; we now
// use websearch_to_tsquery which yields an empty tsquery → no match instead of a syntax error).
describe("PostgresStore searchMemory — stop-word resilience", () => {
  it("returns [] for an all-stop-word query instead of throwing", async () => {
    const store = new PostgresStore(new PGlite());
    await store.migrate();
    const scope = { kind: "agent", agentId: "a1" } as const;
    await store.indexMemory([{ scope, id: "m1", text: "the quick brown fox jumps" }]);
    // "at the" / "in a" tokenize to only English stop words → empty tsquery.
    await expect(store.searchMemory(scope, "at the", 8)).resolves.toEqual([]);
    await expect(store.searchMemory(scope, "in a of", 8)).resolves.toEqual([]);
    // a real token still matches.
    const hits = await store.searchMemory(scope, "fox", 8);
    expect(hits.length).toBeGreaterThan(0);
  });
});

// storeConformanceCases expects a SYNC factory (() => StorePort & GraphPort).
// It calls `await s.migrate()` itself. PostgresStore constructor is now sync,
// and migrate() is async — this matches the SqliteStore pattern exactly.
describe("PostgresStore conformance (pglite, real Postgres in WASM)", () => {
  for (const c of storeConformanceCases(() => {
    // Fresh embedded pglite DB per case → full isolation.
    const client = new PGlite();
    return new PostgresStore(client);
  })) it(c.name, c.run);
});

// durableConformanceCases supports async factories (it awaits makeStore()).
describe("PostgresStore durable conformance (pglite)", () => {
  for (const c of durableConformanceCases(async () => {
    const client = new PGlite();
    return PostgresStore.create({ client });
  })) it(c.name, c.run);
});
