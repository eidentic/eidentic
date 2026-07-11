import { describe, it, expect, afterEach } from "vitest";
import { SqliteStore } from "../src/index.js";
import { EVENT_SCHEMA_VERSION, legacyScopeKey, scopeKey, type Scope } from "@eidentic/types";
import { storeConformanceCases, durableConformanceCases } from "@eidentic/types/testing";

describe("SqliteStore conformance", () => {
  for (const c of storeConformanceCases(() => new SqliteStore(":memory:"))) it(c.name, c.run);
});

describe("SqliteStore durable conformance", () => {
  for (const c of durableConformanceCases(() => new SqliteStore(":memory:"))) it(c.name, c.run);
});

let store: SqliteStore;
afterEach(async () => { await store?.close(); });

describe("SqliteStore sessions & events", () => {
  it("explicitly migrates an authoritative ambiguous legacy scope and refuses target merges", async () => {
    store = new SqliteStore(":memory:");
    await store.migrate();
    const scope: Scope = { kind: "user", agentId: "acme:west", userId: "alice" };
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare("INSERT INTO blocks(scope_key,label,value,version,updated_at) VALUES(?,?,?,?,?)")
      .run(legacyScopeKey(scope), "profile", "legacy", 0, "2026-01-01T00:00:00.000Z");

    await expect(store.getBlock(scope, "profile")).resolves.toBeNull();
    await expect(store.migrateLegacyScope(scope)).resolves.toEqual({ migrated: 1 });
    await expect(store.getBlock(scope, "profile")).resolves.toMatchObject({ value: "legacy" });
    expect(scopeKey(scope)).not.toBe(legacyScopeKey(scope));

    db.prepare("INSERT INTO blocks(scope_key,label,value,version,updated_at) VALUES(?,?,?,?,?)")
      .run(legacyScopeKey(scope), "other", "legacy-2", 0, "2026-01-01T00:00:00.000Z");
    await expect(store.migrateLegacyScope(scope)).rejects.toThrow(/target is not empty/i);
  });

  it("migrates, stores a session, appends and reads ordered events", async () => {
    store = new SqliteStore(":memory:");
    await store.migrate();
    await store.createSession({ id: "s1", agentId: "a1", createdAt: "t0" });
    expect((await store.getSession("s1"))?.agentId).toBe("a1");

    await store.appendEvents([
      { id: "e2", sessionId: "s1", seq: 1, kind: "assistant", schemaVersion: EVENT_SCHEMA_VERSION, payload: { content: [] }, createdAt: "t1" },
      { id: "e1", sessionId: "s1", seq: 0, kind: "user", schemaVersion: EVENT_SCHEMA_VERSION, payload: "hi", createdAt: "t0" },
    ]);
    const events = await store.readEvents("s1");
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(events[0]!.payload).toBe("hi");
  });

  it("scope-isolates blocks; CAS conflict throws; append concatenates", async () => {
    store = new SqliteStore(":memory:");
    await store.migrate();
    const a1: Scope = { kind: "agent", agentId: "a1" };
    const a2: Scope = { kind: "agent", agentId: "a2" };

    const b0 = await store.upsertBlock(a1, { label: "human", value: "Baran" });
    expect(b0.version).toBe(0);
    const b1 = await store.upsertBlock(a1, { label: "human", value: "Baran O" }, 0);
    expect(b1.version).toBe(1);
    await expect(store.upsertBlock(a1, { label: "human", value: "x" }, 0)).rejects.toThrow(/conflict/i);

    const ap = await store.appendBlock(a1, "human", " (founder)");
    expect(ap.value).toBe("Baran O (founder)");

    expect(await store.getBlocks(a2)).toEqual([]);
    expect((await store.getBlocks(a1)).length).toBe(1);
  });
});
