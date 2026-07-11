import { afterAll, afterEach, beforeEach, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { storeConformanceCases, durableConformanceCases } from "@eidentic/types/testing";
import { PostgresStore } from "../src/index.js";

// Hits a real Postgres. SKIPPED unless EIDENTIC_TEST_PG_URL is set.
// Never runs in CI (no env configured). Run locally:
//   EIDENTIC_TEST_PG_URL=postgres://... pnpm --filter @eidentic/postgres test
const url = process.env["EIDENTIC_TEST_PG_URL"];
const live = url ? describe : describe.skip;
const adminPool = url ? new Pool({ connectionString: url }) : undefined;
let testSchema = "";

beforeEach(async () => {
  if (!adminPool) return;
  testSchema = `eidentic_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA "${testSchema}"`);
});

afterEach(async () => {
  if (!adminPool || testSchema === "") return;
  await adminPool.query(`DROP SCHEMA "${testSchema}" CASCADE`);
  testSchema = "";
});

afterAll(async () => {
  await adminPool?.end();
});

function isolatedPool(): Pool {
  if (!url || testSchema === "") throw new Error("live Postgres test schema is not initialized");
  return new Pool({ connectionString: url, options: `-c search_path=${testSchema}` });
}

live("PostgresStore conformance (live Postgres)", () => {
  for (const c of storeConformanceCases(() => {
    return new PostgresStore(isolatedPool());
  })) it(c.name, c.run);
});

live("PostgresStore durable conformance (live Postgres)", () => {
  for (const c of durableConformanceCases(() => {
    return new PostgresStore(isolatedPool());
  })) it(c.name, c.run);
});
