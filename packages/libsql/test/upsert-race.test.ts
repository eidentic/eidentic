/**
 * Regression test for M14: non-CAS upsertBlock race condition.
 *
 * Two (or more) concurrent calls to upsertBlock(expectVersion=undefined) on
 * the same label must each atomically compute version = current + 1 server-
 * side.  Before the fix, both callers would SELECT the same version, then both
 * write version+1 — a lost update.
 *
 * After the fix, the INSERT ... ON CONFLICT DO UPDATE SET version = blocks.version + 1
 * is executed inside a write batch, so the DB serializes the increment and each
 * caller gets a distinct version.
 */

import { describe, it } from "vitest";
import { LibsqlStore } from "../src/index.js";
import type { Scope } from "@eidentic/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`upsert-race: ${msg}`);
}

const scope: Scope = { kind: "agent", agentId: "race-test" };

describe("LibsqlStore — non-CAS upsertBlock concurrency", () => {
  it("concurrent non-CAS upserts produce no lost updates (each gets a unique version)", async () => {
    const store = new LibsqlStore(":memory:");
    await store.migrate();

    const label = "concurrent-block";
    const N = 5;

    // Fire N concurrent upserts with no expectVersion.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.upsertBlock(scope, { label, value: `value-${i}` }),
      ),
    );

    // All must succeed (no conflict errors on non-CAS upserts).
    assert(results.length === N, `expected ${N} results, got ${results.length}`);

    // Each result must have a distinct version (no two callers wrote the same version).
    const versions = results.map((r) => r.version).sort((a, b) => a - b);
    const unique = new Set(versions);
    assert(
      unique.size === N,
      `expected ${N} distinct versions, got ${unique.size}: [${versions.join(", ")}]`,
    );

    // Versions must form a contiguous sequence starting at 0.
    for (let i = 0; i < N; i++) {
      assert(
        versions[i] === i,
        `expected version ${i} at position ${i}, got ${versions[i]}`,
      );
    }

    // The final persisted block must have version N-1.
    const final = await store.getBlock(scope, label);
    assert(final !== null, "block must exist after upserts");
    assert(
      final!.version === N - 1,
      `expected final version ${N - 1}, got ${final!.version}`,
    );

    await store.close();
  });

  it("block_history has one entry per version after concurrent non-CAS upserts", async () => {
    const store = new LibsqlStore(":memory:");
    await store.migrate();

    const label = "history-race-block";
    const N = 4;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.upsertBlock(scope, { label, value: `v${i}` }),
      ),
    );

    const history = await store.getBlockHistory(scope, label);
    assert(
      history.length === N,
      `expected ${N} history entries, got ${history.length}`,
    );

    const histVersions = history.map((h) => h.version).sort((a, b) => a - b);
    for (let i = 0; i < N; i++) {
      assert(
        histVersions[i] === i,
        `expected history version ${i} at position ${i}, got ${histVersions[i]}`,
      );
    }

    await store.close();
  });
});
