/**
 * Tests verifying that PostgresStore uses a single dedicated connection for
 * every multi-statement operation when the injected client looks like a pg.Pool
 * (i.e. it exposes a `connect()` method).
 *
 * A fake pool is constructed whose `query()` round-robins across N distinct fake
 * connection objects, while `connect()` always returns a single dedicated fake
 * client.  After each transactional operation we assert:
 *   1. BEGIN, all body queries, and COMMIT all executed on the SAME connection.
 *   2. `release()` is called on that connection in every case — success, error,
 *      and StoreConflictError.
 */

import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, type PgClient, type PgPoolClient } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fake pool helpers
// ---------------------------------------------------------------------------

interface TrackedClient extends PgPoolClient {
  id: number;
  calls: string[];
  released: boolean;
}

interface FakePool extends PgClient {
  dedicatedClient: TrackedClient;
}

/**
 * Build a fake PgPool.
 *
 * `connect()` returns the same `dedicatedClient` every time, recording all
 * query texts and the `release()` call on it.
 *
 * `pool.query()` round-robins across `poolClientCount` cheap clients — each
 * has its own `calls` array so tests can confirm the pool path is NOT used for
 * transactional work.
 */
function makeFakePool(poolClientCount = 3): FakePool {
  let roundRobinIdx = 0;
  const poolClients: TrackedClient[] = Array.from({ length: poolClientCount }, (_, i) => ({
    id: 100 + i,
    calls: [],
    released: false,
    query: async (text: string) => {
      poolClients[i]!.calls.push(text);
      return { rows: [] };
    },
    release: () => { poolClients[i]!.released = true; },
  }));

  let dedicatedClientReleased = false;
  const dedicatedCalls: string[] = [];
  const dedicated: TrackedClient = {
    id: 999,
    calls: dedicatedCalls,
    released: false,
    query: async (text: string) => {
      dedicatedCalls.push(text);
      return { rows: [] };
    },
    release: () => { dedicated.released = true; dedicatedClientReleased = true; },
  };

  const pool: FakePool = {
    dedicatedClient: dedicated,
    query: async (text: string) => {
      const c = poolClients[roundRobinIdx % poolClientCount]!;
      roundRobinIdx++;
      c.calls.push(text);
      return { rows: [] };
    },
    connect: async () => {
      // Reset dedicated client tracking for the new checkout.
      dedicated.calls.length = 0;
      dedicated.released = false;
      dedicatedClientReleased = false;
      return dedicated;
    },
  };

  return pool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if BEGIN, at least one other call, and COMMIT are all present. */
function hasTransaction(calls: string[]): boolean {
  return calls.some((c) => /^BEGIN/i.test(c)) &&
    calls.some((c) => /^COMMIT/i.test(c));
}

// ---------------------------------------------------------------------------
// Pool migration: We need a real pglite for migration, but use fake pool for
// the transactional method calls.  The store is constructed with the fake pool
// after migration.
// ---------------------------------------------------------------------------

async function makeMigratedFakePoolStore(): Promise<{ store: PostgresStore; pool: FakePool }> {
  // 1. Migrate schema into a real pglite so the pool store can operate.
  // We won't use this pglite for the transactional calls — only for migration.
  // Actually the fake pool returns empty rows, so the store methods will fail
  // mid-way.  Instead we build on top of a real pglite-based store that is
  // already migrated, then swap the client out via a workaround.
  //
  // Simpler approach: construct the store with the fake pool and call migrate()
  // — but migrate() issues DDL, not DML, so empty rows are fine.
  const pool = makeFakePool();
  // We need migrate() to actually run DDL. Use a pglite for that, then
  // re-wrap the pool. Actually, for the purpose of testing transaction routing
  // we don't need the DDL to succeed — we just need to observe which client
  // gets the calls. So use a pglite for migration and pass the fake pool after.
  const pg = new PGlite();
  const realStore = new PostgresStore(pg);
  await realStore.migrate();

  // Now create a store that uses the fake pool — but its query() method will
  // route to dedicated when inside withTransaction.
  // We need the pool's query to actually proxy to pglite so SELECTs work.
  // Build a "smart fake pool" that proxies to pglite for data queries but
  // uses the dedicated fake client to track transaction calls.
  const pgAware = makeFakePoolProxiedToPglite(pg);
  const store = new PostgresStore(pgAware);
  return { store, pool: pgAware };
}

/**
 * A pool-like client whose `connect()` returns a dedicated client that proxies
 * all queries to `pg` — so real SQL executes — but also records every query
 * text and whether `release()` was called.
 */
function makeFakePoolProxiedToPglite(pg: PGlite): FakePool & { dedicatedClient: TrackedClient } {
  const calls: string[] = [];
  let released = false;

  const dedicated: TrackedClient = {
    id: 999,
    calls,
    released: false,
    query: async (text: string, params?: unknown[]) => {
      const normalized = text.trim().replace(/\s+/g, " ");
      if (/^BEGIN/i.test(normalized)) calls.push(normalized.toUpperCase());
      else if (/pg_advisory_xact_lock/i.test(normalized)) calls.push("ADVISORY_LOCK");
      else calls.push(normalized.split(" ")[0]!.toUpperCase());
      return pg.query(text, params as unknown[]);
    },
    release: () => {
      released = true;
      dedicated.released = true;
    },
  };

  const pool: FakePool & { dedicatedClient: TrackedClient } = {
    dedicatedClient: dedicated,
    // pool.query() round-robins to different "connections" — should NOT be used
    // for transactional work.
    query: async (text: string, params?: unknown[]) => {
      // Mark it with a tag so assertions can detect direct pool usage.
      calls.push(`POOL_DIRECT:${text.trim().split(/\s+/)[0]!.toUpperCase()}`);
      return pg.query(text, params as unknown[]);
    },
    connect: async () => {
      calls.length = 0;
      released = false;
      dedicated.released = false;
      return dedicated;
    },
  };

  return pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PostgresStore — pool connection isolation", () => {
  it("appendEvents: BEGIN/body/COMMIT all on dedicated client; release() called on success", async () => {
    const pg = new PGlite();
    const store = new PostgresStore(pg);
    await store.migrate();

    const pool = makeFakePoolProxiedToPglite(pg);
    const poolStore = new PostgresStore(pool);

    await poolStore.createSession({ id: "s1", agentId: "a1", createdAt: new Date().toISOString() });

    // Reset tracking before the transactional call.
    pool.dedicatedClient.calls.length = 0;
    pool.dedicatedClient.released = false;

    await poolStore.appendEvents([
      {
        id: "e1", sessionId: "s1", seq: 0, kind: "user",
        schemaVersion: 1, payload: "hi", createdAt: new Date().toISOString(),
      },
    ]);

    const calls = pool.dedicatedClient.calls;
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
    expect(pool.dedicatedClient.released).toBe(true);
    // No call should be routed to the pool directly.
    expect(calls.some((c) => c.startsWith("POOL_DIRECT:"))).toBe(false);
  });

  it("appendEvents: release() called even when an error is thrown (ROLLBACK path)", async () => {
    const pg = new PGlite();
    const store = new PostgresStore(pg);
    await store.migrate();

    const pool = makeFakePoolProxiedToPglite(pg);
    const poolStore = new PostgresStore(pool);

    await poolStore.createSession({ id: "s1", agentId: "a1", createdAt: new Date().toISOString() });
    // Insert once successfully.
    await poolStore.appendEvents([
      { id: "e1", sessionId: "s1", seq: 0, kind: "user", schemaVersion: 1, payload: "hi", createdAt: new Date().toISOString() },
    ]);

    pool.dedicatedClient.calls.length = 0;
    pool.dedicatedClient.released = false;

    // Duplicate — will conflict.
    await expect(poolStore.appendEvents([
      { id: "e1", sessionId: "s1", seq: 0, kind: "user", schemaVersion: 1, payload: "hi", createdAt: new Date().toISOString() },
    ])).rejects.toThrow(/conflict/i);

    const calls = pool.dedicatedClient.calls;
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    // release() must be called regardless.
    expect(pool.dedicatedClient.released).toBe(true);
  });

  it("upsertBlock StoreConflictError path: release() is still called", async () => {
    const pg = new PGlite();
    const store = new PostgresStore(pg);
    await store.migrate();

    const pool = makeFakePoolProxiedToPglite(pg);
    const poolStore = new PostgresStore(pool);

    const scope = { kind: "agent" as const, agentId: "a1" };
    // Create block at version 0.
    await poolStore.upsertBlock(scope, { label: "b", value: "v0" });

    pool.dedicatedClient.calls.length = 0;
    pool.dedicatedClient.released = false;

    // CAS with wrong version — should conflict.
    await expect(poolStore.upsertBlock(scope, { label: "b", value: "v2" }, 5)).rejects.toThrow(/conflict/i);

    expect(pool.dedicatedClient.released).toBe(true);
  });

  it("assertFact uses a serializable transaction and tuple advisory lock", async () => {
    const pg = new PGlite();
    try {
      const store = new PostgresStore(pg);
      await store.migrate();
      const pool = makeFakePoolProxiedToPglite(pg);
      const poolStore = new PostgresStore(pool, { newId: () => "fact-1" });

      await poolStore.assertFact(
        { kind: "agent", agentId: "a1" },
        { subject: "Agent", predicate: "status", object: "ready" },
      );

      expect(pool.dedicatedClient.calls).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
      expect(pool.dedicatedClient.calls).toContain("ADVISORY_LOCK");
      expect(pool.dedicatedClient.calls).toContain("COMMIT");
      expect(pool.dedicatedClient.released).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("indexMemory([]) issues zero queries to the pool client", async () => {
    const pg = new PGlite();
    const store = new PostgresStore(pg);
    await store.migrate();

    const querySpy = vi.fn().mockResolvedValue({ rows: [] });
    const noopClient: PgClient = { query: querySpy };
    const spyStore = new PostgresStore(noopClient);

    await spyStore.indexMemory([]);

    expect(querySpy).not.toHaveBeenCalled();
  });
});
