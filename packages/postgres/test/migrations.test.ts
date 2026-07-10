import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";

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
  });
});
