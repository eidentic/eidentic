import { describe, it } from "vitest";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { PgVectorStore } from "../src/index.js";

// Hits a real Postgres with pgvector installed. SKIPPED unless EIDENTIC_TEST_PG_URL is set.
// Never runs in CI (no env configured). Run locally:  EIDENTIC_TEST_PG_URL=postgres://... pnpm --filter @eidentic/pgvector test
const url = process.env.EIDENTIC_TEST_PG_URL;
const live = url ? describe : describe.skip;

live("PgVectorStore conformance (live Postgres)", () => {
  for (const c of vectorConformanceCases(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    // Unique table per case for isolation; the conformance suite only writes a handful of rows.
    const table = `memories_${Math.random().toString(36).slice(2, 10)}`;
    const store = await PgVectorStore.create({ client: pool, table, dim: 4 });
    return store;
  })) it(c.name, c.run);
});
