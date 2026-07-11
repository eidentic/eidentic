import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { PgVectorStore } from "../src/index.js";

function makePglite() {
  return new PGlite({ extensions: { vector } });
}

describe("PgVectorStore conformance (pglite, real Postgres in WASM)", () => {
  for (const c of vectorConformanceCases(async () => {
    // Fresh embedded DB per case → full isolation, matches lancedb's tmpdir-per-case style.
    const client = makePglite();
    return PgVectorStore.create({ client, table: "memories", dim: 4 });
  })) it(c.name, c.run);
});

describe("PgVectorStore cross-tenant isolation (composite PK)", () => {
  it("same id in different scopes produces two independent rows", async () => {
    const client = makePglite();
    const store = await PgVectorStore.create({ client, table: "memories", dim: 3 });

    const vec: number[] = [1, 0, 0];
    await store.upsert({ id: "x", scopeKey: "a", text: "tenant-A", vector: vec });
    await store.upsert({ id: "x", scopeKey: "b", text: "tenant-B", vector: vec });

    // Both rows must exist in the underlying table
    const { rows } = await client.query("SELECT id, scope_key, text FROM memories ORDER BY scope_key");
    expect(rows).toHaveLength(2);
    const r = rows as Array<Record<string, unknown>>;
    expect(r.find((row) => row["scope_key"] === "a")?.["text"]).toBe("tenant-A");
    expect(r.find((row) => row["scope_key"] === "b")?.["text"]).toBe("tenant-B");
  });

  it("tenant A's row is untouched after tenant B upserts the same id", async () => {
    const client = makePglite();
    const store = await PgVectorStore.create({ client, table: "memories", dim: 3 });

    const vec: number[] = [1, 0, 0];
    await store.upsert({ id: "x", scopeKey: "a", text: "original-A", vector: vec });
    await store.upsert({ id: "x", scopeKey: "b", text: "tenant-B", vector: vec });
    // Overwrite from tenant B's perspective — must not touch tenant A
    await store.upsert({ id: "x", scopeKey: "b", text: "updated-B", vector: [0, 1, 0] });

    const { rows } = await client.query("SELECT text, embedding::text FROM memories WHERE scope_key = 'a'");
    expect(rows).toHaveLength(1);
    const row = (rows as Array<Record<string, unknown>>)[0]!;
    expect(row["text"]).toBe("original-A");
  });

  it("search in scope a finds only scope-a row", async () => {
    const client = makePglite();
    const store = await PgVectorStore.create({ client, table: "memories", dim: 3 });

    const vec: number[] = [1, 0, 0];
    await store.upsert({ id: "x", scopeKey: "a", text: "tenant-A", vector: vec });
    await store.upsert({ id: "x", scopeKey: "b", text: "tenant-B", vector: vec });

    const hits = await store.search(vec, "a", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("tenant-A");
  });

  it("delete by id in scope b removes only scope-b row", async () => {
    const client = makePglite();
    const store = await PgVectorStore.create({ client, table: "memories", dim: 3 });

    const vec: number[] = [1, 0, 0];
    await store.upsert({ id: "x", scopeKey: "a", text: "tenant-A", vector: vec });
    await store.upsert({ id: "x", scopeKey: "b", text: "tenant-B", vector: vec });

    await store.delete("x", "b");

    const { rows } = await client.query("SELECT scope_key FROM memories");
    expect(rows).toHaveLength(1);
    expect((rows as Array<Record<string, unknown>>)[0]?.["scope_key"]).toBe("a");
  });
});

describe("PgVectorStore legacy single-column PK migration", () => {
  it("migrates a pre-existing single-column id PK to composite (id, scope_key)", async () => {
    const client = makePglite();
    // Set up an old-schema table manually: single-column primary key on `id` only.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await client.query(
      "CREATE TABLE memories (" +
        "id text PRIMARY KEY, " +
        "scope_key text NOT NULL, " +
        "text text NOT NULL, " +
        "embedding vector(3)" +
        ")",
    );
    // Insert a row under the old schema
    await client.query(
      "INSERT INTO memories (id, scope_key, text, embedding) VALUES ($1, $2, $3, $4)",
      ["existing-id", "scope-a", "old-data", "[1,0,0]"],
    );

    // Running create should detect the legacy constraint and migrate it idempotently
    await PgVectorStore.create({ client, table: "memories", dim: 3 });

    // Old row must still exist after migration
    const { rows: existing } = await client.query("SELECT text FROM memories WHERE id = 'existing-id'");
    expect(existing).toHaveLength(1);
    expect((existing as Array<Record<string, unknown>>)[0]?.["text"]).toBe("old-data");

    // Composite PK now allows the same id in a different scope
    const store = await PgVectorStore.create({ client, table: "memories", dim: 3 });
    await store.upsert({ id: "existing-id", scopeKey: "scope-b", text: "new-tenant", vector: [0, 1, 0] });

    const { rows: allRows } = await client.query("SELECT scope_key FROM memories WHERE id = 'existing-id' ORDER BY scope_key");
    expect(allRows).toHaveLength(2);
  });

  it("create is idempotent when called twice on a composite-PK table", async () => {
    const client = makePglite();
    const store1 = await PgVectorStore.create({ client, table: "memories", dim: 3 });
    await store1.upsert({ id: "y", scopeKey: "s1", text: "hello", vector: [1, 0, 0] });

    // Second create must not lose data or throw
    await PgVectorStore.create({ client, table: "memories", dim: 3 });

    const { rows } = await client.query("SELECT id FROM memories");
    expect(rows).toHaveLength(1);
  });

  it("quotes a pre-existing constraint identifier during migration", async () => {
    const client = makePglite();
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await client.query(
      `CREATE TABLE memories (` +
        `id text NOT NULL, scope_key text NOT NULL, text text NOT NULL, embedding vector(3), ` +
        `CONSTRAINT "legacy""; DROP TABLE memories; --" PRIMARY KEY (id))`,
    );
    await PgVectorStore.create({ client, table: "memories", dim: 3 });
    const { rows } = await client.query("SELECT to_regclass('memories') AS name");
    expect((rows[0] as { name: string }).name).toBe("memories");
  });
});
