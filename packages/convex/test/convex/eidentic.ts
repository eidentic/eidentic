/**
 * The host app's functions module, as a test fixture. The user re-exports the package handlers
 * from a file in their `convex/` dir; here we do the same. The module is named `eidentic.ts` so
 * the function paths resolve as "eidentic:<name>" — matching `defaultStoreFns()` / `defaultVectorFns()`.
 */
export * from "../../src/server.js";
