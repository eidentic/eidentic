import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { LibsqlStore } from "../src/index.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("libSQL durable ownership migration", () => {
  it("backfills only unambiguous legacy session-prefixed idempotency keys", async () => {
    dir = await mkdtemp(join(tmpdir(), "eidentic-libsql-migration-"));
    const url = `file:${join(dir, "legacy.sqlite")}`;
    const client = createClient({ url });
    await client.execute(`CREATE TABLE _eidentic_migrations (version INTEGER PRIMARY KEY)`);
    for (const migration of MIGRATIONS.filter((item) => item.version < 13)) {
      await client.batch([
        ...migration.sql.map((sql) => ({ sql })),
        { sql: `INSERT INTO _eidentic_migrations (version) VALUES (?)`, args: [migration.version] },
      ], "write");
    }
    await client.batch([
      { sql: `INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`, args: ["alice-session", "agent", "now", "alice"] },
      { sql: `INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`, args: ["prefix", "agent", "now", "bob"] },
      { sql: `INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`, args: ["prefix:child", "agent", "now", "carol"] },
      { sql: `INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES (?, 'h', 'intent', NULL, 'now')`, args: ["alice-session:tool"] },
      { sql: `INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES (?, 'h', 'intent', NULL, 'now')`, args: ["prefix:child:tool"] },
    ], "write");
    client.close();

    const store = new LibsqlStore(url);
    await store.migrate();
    expect((await store.getIdempotency("alice-session:tool"))?.sessionId).toBe("alice-session");
    expect((await store.getIdempotency("prefix:child:tool"))?.sessionId).toBeUndefined();
    await store.eraseScope({ kind: "user", agentId: "agent", userId: "alice" });
    expect(await store.getIdempotency("alice-session:tool")).toBeNull();
    expect(await store.getIdempotency("prefix:child:tool")).not.toBeNull();
    await store.close();
  });
});

describe("libSQL current-fact migration", () => {
  it("repairs legacy duplicate current facts before enforcing uniqueness", async () => {
    dir = await mkdtemp(join(tmpdir(), "eidentic-libsql-graph-migration-"));
    const client = createClient({ url: `file:${join(dir, "legacy.sqlite")}` });
    try {
      await client.execute(`CREATE TABLE _eidentic_migrations (version INTEGER PRIMARY KEY)`);
      for (const migration of MIGRATIONS.filter((item) => item.version < 14)) {
        await client.batch([
          ...migration.sql.map((sql) => ({ sql })),
          { sql: `INSERT INTO _eidentic_migrations (version) VALUES (?)`, args: [migration.version] },
        ], "write");
      }
      await client.executeMultiple(
        `INSERT INTO facts
           (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence)
         VALUES
           ('older', 'agent:a', 'Agent', 'status', 'idle', 'literal', '2026-01-01T00:00:00.000Z', NULL, 1),
           ('newer', 'agent:a', 'Agent', 'status', 'busy', 'literal', '2026-01-02T00:00:00.000Z', NULL, 1)`,
      );

      await runMigrations(client);

      const result = await client.execute(
        `SELECT id, valid_until FROM facts
         WHERE scope_key = 'agent:a' AND subject = 'Agent' AND predicate = 'status'
         ORDER BY id`,
      );
      expect(result.rows).toEqual([
        { id: "newer", valid_until: null },
        { id: "older", valid_until: "2026-01-02T00:00:00.000Z" },
      ]);
      await expect(client.execute(
        `INSERT INTO facts
           (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence)
         VALUES ('duplicate', 'agent:a', 'Agent', 'status', 'away', 'literal', '2026-01-03T00:00:00.000Z', NULL, 1)`,
      )).rejects.toThrow(/unique|constraint/i);
    } finally {
      client.close();
    }
  });
});
