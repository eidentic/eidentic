import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { runMigrations } from "../src/migrations.js";

describe("Postgres migration coordination", () => {
  it("uses one checked-out pool connection and an advisory transaction lock", async () => {
    const calls: string[] = [];
    let released = false;
    const connection = {
      async query(text: string): Promise<{ rows: any[] }> {
        calls.push(text.trim().replace(/\s+/g, " "));
        return { rows: [] };
      },
      release(): void { released = true; },
    };
    const pool = {
      async query(): Promise<{ rows: any[] }> {
        throw new Error("migration used pool.query directly");
      },
      async connect() { return connection; },
    };

    await runMigrations(pool);

    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toContain("pg_advisory_xact_lock");
    expect(calls.at(-1)).toBe("COMMIT");
    expect(released).toBe(true);
  });

  it("rolls back and releases the checked-out connection on migration failure", async () => {
    const calls: string[] = [];
    let released = false;
    const connection = {
      async query(text: string): Promise<{ rows: any[] }> {
        const normalized = text.trim().replace(/\s+/g, " ");
        calls.push(normalized);
        if (normalized.startsWith("CREATE TABLE IF NOT EXISTS sessions")) throw new Error("ddl failed");
        return { rows: [] };
      },
      release(): void { released = true; },
    };
    const pool = {
      async query(): Promise<{ rows: any[] }> { throw new Error("unexpected pool.query"); },
      async connect() { return connection; },
    };

    await expect(runMigrations(pool)).rejects.toThrow("ddl failed");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(released).toBe(true);
  });
});

describe("Postgres durable ownership migration", () => {
  it("backfills only unambiguous legacy session-prefixed idempotency keys", async () => {
    const client = new PGlite();
    await client.query(`CREATE TABLE _eidentic_migrations (version INTEGER PRIMARY KEY)`);
    for (const migration of MIGRATIONS.filter((item) => item.version < 11)) {
      await client.query("BEGIN");
      for (const sql of migration.sql.split(";").map((part) => part.trim()).filter(Boolean)) {
        await client.query(sql);
      }
      await client.query(`INSERT INTO _eidentic_migrations (version) VALUES ($1)`, [migration.version]);
      await client.query("COMMIT");
    }
    await client.query(
      `INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES
       ('alice-session', 'agent', 'now', 'alice'),
       ('prefix', 'agent', 'now', 'bob'),
       ('prefix:child', 'agent', 'now', 'carol')`,
    );
    await client.query(
      `INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES
       ('alice-session:tool', 'h', 'intent', NULL, 'now'),
       ('prefix:child:tool', 'h', 'intent', NULL, 'now')`,
    );

    const store = new PostgresStore(client);
    await store.migrate();
    expect((await store.getIdempotency("alice-session:tool"))?.sessionId).toBe("alice-session");
    expect((await store.getIdempotency("prefix:child:tool"))?.sessionId).toBeUndefined();
    await store.eraseScope({ kind: "user", agentId: "agent", userId: "alice" });
    expect(await store.getIdempotency("alice-session:tool")).toBeNull();
    expect(await store.getIdempotency("prefix:child:tool")).not.toBeNull();
    await client.close();
  }, 15_000);
});

describe("Postgres current-fact migration", () => {
  it("repairs legacy duplicate current facts before enforcing uniqueness", async () => {
    const client = new PGlite();
    try {
      await client.query(`CREATE TABLE _eidentic_migrations (version INTEGER PRIMARY KEY)`);
      for (const migration of MIGRATIONS.filter((item) => item.version < 12)) {
        await client.query("BEGIN");
        for (const sql of migration.sql.split(";").map((part) => part.trim()).filter(Boolean)) {
          await client.query(sql);
        }
        await client.query(`INSERT INTO _eidentic_migrations (version) VALUES ($1)`, [migration.version]);
        await client.query("COMMIT");
      }
      await client.query(
        `INSERT INTO facts
           (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence)
         VALUES
           ('older', 'agent:a', 'Agent', 'status', 'idle', 'literal', '2026-01-01T00:00:00.000Z', NULL, 1),
           ('newer', 'agent:a', 'Agent', 'status', 'busy', 'literal', '2026-01-02T00:00:00.000Z', NULL, 1)`,
      );

      await new PostgresStore(client).migrate();

      const { rows } = await client.query<{ id: string; valid_until: string | null }>(
        `SELECT id, valid_until FROM facts
         WHERE scope_key = 'agent:a' AND subject = 'Agent' AND predicate = 'status'
         ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: "newer", valid_until: null },
        { id: "older", valid_until: "2026-01-02T00:00:00.000Z" },
      ]);
      await expect(client.query(
        `INSERT INTO facts
           (id, scope_key, subject, predicate, object, object_kind, valid_from, valid_until, confidence)
         VALUES ('duplicate', 'agent:a', 'Agent', 'status', 'away', 'literal', '2026-01-03T00:00:00.000Z', NULL, 1)`,
      )).rejects.toThrow(/unique|duplicate/i);
    } finally {
      await client.close();
    }
  });
});
