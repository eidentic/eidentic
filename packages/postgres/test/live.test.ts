import { describe, it } from "vitest";
import { storeConformanceCases, durableConformanceCases } from "@eidentic/types/testing";
import { PostgresStore } from "../src/index.js";

// Hits a real Postgres. SKIPPED unless EIDENTIC_TEST_PG_URL is set.
// Never runs in CI (no env configured). Run locally:
//   EIDENTIC_TEST_PG_URL=postgres://... pnpm --filter @eidentic/postgres test
const url = process.env["EIDENTIC_TEST_PG_URL"];
const live = url ? describe : describe.skip;

live("PostgresStore conformance (live Postgres)", () => {
  for (const c of storeConformanceCases(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    return PostgresStore.create({ client: pool });
  })) it(c.name, c.run);
});

live("PostgresStore durable conformance (live Postgres)", () => {
  for (const c of durableConformanceCases(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    return PostgresStore.create({ client: pool });
  })) it(c.name, c.run);
});
