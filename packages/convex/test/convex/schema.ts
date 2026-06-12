/**
 * The host app's schema, as a test fixture. The user spreads `eidenticTables` into their own
 * `defineSchema` — here we spread it alone. `convex-test` reads this default export.
 */
import { defineSchema } from "convex/server";
import { eidenticTables } from "../../src/schema.js";

export default defineSchema({
  ...eidenticTables,
});
