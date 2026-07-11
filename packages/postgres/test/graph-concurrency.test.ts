import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { PostgresStore } from "../src/index.js";

describe("PostgresStore current-fact concurrency", () => {
  it("serializes concurrent assertions across store instances sharing a client", async () => {
    const client = new PGlite();
    let nextId = 0;
    const makeStore = () => new PostgresStore(client, {
      newId: () => `fact-${nextId++}`,
    });
    const first = makeStore();
    const second = makeStore();
    try {
      await first.migrate();
      const scope = { kind: "agent", agentId: "concurrent" } as const;
      const validFrom = "2026-01-01T00:00:00.000Z";

      const results = await Promise.all([
        first.assertFact(scope, {
          subject: "Agent",
          predicate: "status",
          object: "idle",
          validFrom,
        }),
        second.assertFact(scope, {
          subject: "Agent",
          predicate: "status",
          object: "busy",
          validFrom,
        }),
      ]);

      expect(results).toHaveLength(2);
      const current = await first.queryFacts({ scope, subject: "Agent", predicate: "status" });
      const history = await first.factHistory(scope, "Agent", "status");
      expect(current).toHaveLength(1);
      expect(history).toHaveLength(2);
      expect(history.filter((fact) => fact.validUntil === undefined)).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 15_000);
});
