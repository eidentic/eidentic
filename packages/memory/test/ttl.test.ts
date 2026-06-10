import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import { SqliteStore } from "@eidentic/sqlite";
import type { GraphPort, StorePort, Scope } from "@eidentic/types";
import { Memory } from "../src/memory.js";

const scope: Scope = { kind: "agent", agentId: "ttl-agent" };
const t1 = "2026-01-01T00:00:00.000Z";
const afterExpiry = "2026-01-01T00:02:00.000Z";

type MakeStore = () => StorePort & GraphPort;

const backends: Array<[string, MakeStore]> = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteStore", () => new SqliteStore(":memory:")],
];

describe.each(backends)("Memory.sweepExpiredFacts (%s)", (_label, makeStore) => {
  it("sweepExpiredFacts invalidates 1 expired fact; non-TTL fact survives; invalidated row preserved", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store });

      // Assert a TTL'd "Token" fact (60s TTL)
      const r = await mem.assertFact(scope, { subject: "Token", predicate: "session", object: "abc", validFrom: t1, ttlMs: 60_000 });
      expect(r.asserted.expiresAt).toBe("2026-01-01T00:01:00.000Z");

      // Assert a non-TTL "User" fact
      await mem.assertFact(scope, { subject: "User", predicate: "name", object: "Baran", validFrom: t1 });

      // Both visible before sweep
      const before = await mem.queryFacts({ scope });
      expect(before.length).toBe(2);

      // Sweep after expiry: 1 invalidated
      const swept = await mem.sweepExpiredFacts(scope, afterExpiry);
      expect(swept).toBe(1);

      // Only the non-TTL fact remains currently-valid
      const after = await mem.queryFacts({ scope });
      expect(after.length).toBe(1);
      expect(after[0]!.subject).toBe("User");

      // includeInvalidated shows both (preserved, NOT deleted)
      const all = await mem.queryFacts({ scope, includeInvalidated: true });
      expect(all.length).toBe(2);
      const expired = all.find((f) => f.subject === "Token");
      expect(expired).toBeDefined();
      expect(expired!.validUntil).toBe(afterExpiry);
    } finally {
      await store.close();
    }
  });

  it("sweepExpiredFacts throws when no graph configured", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const memNoGraph = new Memory({ store });
      await expect(memNoGraph.sweepExpiredFacts(scope)).rejects.toThrow(/no graph/);
    } finally {
      await store.close();
    }
  });
});
