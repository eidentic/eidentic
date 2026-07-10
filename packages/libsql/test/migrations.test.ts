import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { LibsqlStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";

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
