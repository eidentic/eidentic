/**
 * Concurrency tests for @eidentic/libsql atomic operations.
 *
 * These tests verify that appendBlock, upsertBlock (CAS), and assertFact
 * are serialized correctly under concurrent writes, preventing data loss
 * and duplicate-valid-fact races.
 *
 * The tests use a local file-backed database (not :memory:) because the
 * @libsql/client in-process sqlite3 driver serializes concurrent transactions
 * on the same connection object; a file path triggers the same driver but
 * allows us to stress the locking path.
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibsqlStore } from "../src/index.js";
import type { Scope } from "@eidentic/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`concurrency: ${msg}`);
}

/** Create a store backed by a temp file, run a test, then clean up. */
function withFileStore(fn: (s: LibsqlStore) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-libsql-test-"));
    const dbPath = join(dir, "test.db");
    const store = new LibsqlStore(`file:${dbPath}`);
    await store.migrate();
    try {
      await fn(store);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const scope: Scope = { kind: "agent", agentId: "concurrency-test" };

describe("LibsqlStore concurrency", () => {
  it(
    "appendBlock: 20 concurrent appends all survive (no data loss)",
    withFileStore(async (s) => {
      // Seed the block first so we don't race on creation.
      await s.upsertBlock(scope, { label: "log", value: "" });

      const N = 20;
      const tokens = Array.from({ length: N }, (_, i) => `[msg${i}]`);

      // Fire all appends concurrently.
      await Promise.all(tokens.map((t) => s.appendBlock(scope, "log", t)));

      const block = await s.getBlock(scope, "log");
      assert(block !== null, "block must exist after appends");

      // Every token must appear in the final value.
      for (const token of tokens) {
        assert(
          block!.value.includes(token),
          `token ${token} missing from final value: ${block!.value}`,
        );
      }

      // Version must equal N (each append increments version by 1).
      assert(
        block!.version === N,
        `expected version ${N} after ${N} appends, got ${block!.version}`,
      );
    }),
  );

  it(
    "upsertBlock CAS: exactly one concurrent winner, rest throw StoreConflictError",
    withFileStore(async (s) => {
      // Create the block at version 0.
      await s.upsertBlock(scope, { label: "cas", value: "initial" });

      const N = 10;
      const results = await Promise.allSettled(
        Array.from({ length: N }, (_, i) =>
          s.upsertBlock(scope, { label: "cas", value: `winner-${i}` }, 0),
        ),
      );

      const successes = results.filter((r) => r.status === "fulfilled");
      const conflicts = results.filter((r) => r.status === "rejected");

      assert(successes.length === 1, `expected exactly 1 CAS winner, got ${successes.length}`);
      assert(
        conflicts.length === N - 1,
        `expected ${N - 1} StoreConflictErrors, got ${conflicts.length}`,
      );

      // Every failure must be a StoreConflictError (or at least mention "conflict").
      for (const r of conflicts) {
        const msg =
          r.status === "rejected" && r.reason instanceof Error
            ? r.reason.message
            : String((r as PromiseRejectedResult).reason);
        assert(/conflict/i.test(msg), `expected conflict error, got: ${msg}`);
      }
    }),
  );

  it(
    "assertFact: 10 concurrent asserts for the same (subject, predicate) leave exactly one currently-valid fact",
    withFileStore(async (s) => {
      const baseTime = "2026-01-01T00:00:00.000Z";
      const N = 10;

      // Each concurrent assert uses a slightly different validFrom so they don't
      // all trip the idempotency (same-object) fast-path; they each assert a
      // *distinct* object. The transaction serialization must ensure that after all
      // settle, exactly one has valid_until = NULL.
      await Promise.allSettled(
        Array.from({ length: N }, (_, i) => {
          const ms = i * 1; // 1 ms apart — all distinct but very close
          const t = new Date(new Date(baseTime).getTime() + ms).toISOString();
          return s.assertFact(scope, {
            subject: "Agent",
            predicate: "status",
            object: `value-${i}`,
            validFrom: t,
          });
        }),
      );

      // Regardless of how many succeeded vs failed (temporal-order rejections are OK),
      // there must be exactly one currently-valid fact.
      const current = await s.queryFacts({ scope, subject: "Agent", predicate: "status" });
      assert(
        current.length === 1,
        `expected exactly 1 currently-valid fact, got ${current.length}`,
      );
      assert(
        current[0]?.validUntil === undefined,
        "the surviving fact must have validUntil = undefined",
      );
    }),
  );

  it("assertFact coordinates current-fact transitions across store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-libsql-multi-store-"));
    const url = `file:${join(dir, "test.db")}`;
    let firstId = 0;
    let secondId = 0;
    const first = new LibsqlStore({ url, newId: () => `first-${firstId++}` });
    const second = new LibsqlStore({ url, newId: () => `second-${secondId++}` });
    try {
      await first.migrate();
      const validFrom = "2026-01-01T00:00:00.000Z";
      const stores = [first, second] as const;
      const assertions = Array.from({ length: 20 }, (_, index) =>
        stores[index % stores.length]!.assertFact(scope, {
          subject: "Agent",
          predicate: "multi-instance-status",
          object: `state-${index}`,
          validFrom,
        }));
      const results = await Promise.all(assertions);

      assert(results.length === assertions.length, "every serialized assertion must complete");
      const current = await first.queryFacts({
        scope,
        subject: "Agent",
        predicate: "multi-instance-status",
      });
      const history = await first.factHistory(scope, "Agent", "multi-instance-status");
      assert(current.length === 1, `expected one current fact, got ${current.length}`);
      assert(
        history.length === assertions.length,
        `expected ${assertions.length} historical facts, got ${history.length}`,
      );
      assert(
        history.filter((fact) => fact.validUntil === undefined).length === 1,
        "exactly one fact must remain current",
      );
    } finally {
      await first.close();
      await second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
