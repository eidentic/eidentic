import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("SQLite durable ownership migration", () => {
  it("backfills an unambiguous legacy session key and leaves ambiguous prefixes unowned", async () => {
    dir = await mkdtemp(join(tmpdir(), "eidentic-sqlite-migration-"));
    const path = join(dir, "legacy.sqlite");
    const db = new Database(path);
    db.exec(`CREATE TABLE _eidentic_migrations (version INTEGER PRIMARY KEY)`);
    for (const migration of MIGRATIONS.filter((item) => item.version < 13)) {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO _eidentic_migrations (version) VALUES (?)`).run(migration.version);
    }
    db.prepare(`INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
      "alice-session", "agent", "2026-01-01T00:00:00.000Z", "alice",
    );
    db.prepare(`INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
      "prefix", "agent", "2026-01-01T00:00:00.000Z", "bob",
    );
    db.prepare(`INSERT INTO sessions (id, agent_id, created_at, user_id) VALUES (?, ?, ?, ?)`).run(
      "prefix:child", "agent", "2026-01-01T00:00:00.000Z", "carol",
    );
    const insert = db.prepare(`INSERT INTO idempotency_keys (key, args_hash, status, result, created_at) VALUES (?, 'h', 'intent', NULL, 'now')`);
    insert.run("alice-session:tool");
    insert.run("prefix:child:tool");
    db.close();

    const store = new SqliteStore(path);
    await store.migrate();
    expect((await store.getIdempotency("alice-session:tool"))?.sessionId).toBe("alice-session");
    expect((await store.getIdempotency("prefix:child:tool"))?.sessionId).toBeUndefined();

    await store.eraseScope({ kind: "user", agentId: "agent", userId: "alice" });
    expect(await store.getIdempotency("alice-session:tool")).toBeNull();
    expect(await store.getIdempotency("prefix:child:tool")).not.toBeNull();
    await store.close();
  });
});
