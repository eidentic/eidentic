import { convexTest } from "convex-test";
import schema from "./convex/schema.js";
import type { ConvexRunner } from "../src/index.js";

/**
 * The glob of test convex modules. `convex-test` resolves a function ref's path (e.g.
 * "eidentic:appendEvents") against this map, so it must include `./convex/eidentic.ts`.
 * The import.meta.glob call is statically analyzed by Vite — the pattern cannot be a variable.
 */
const modules = import.meta.glob("./convex/**/*.ts");

/** A fresh, isolated convex-test instance + a `ConvexRunner` that drives it. One per test. */
export function makeTestRunner(): ConvexRunner {
  const t = convexTest(schema, modules);
  return {
    // `convex-test` accepts a plain string-path ref ("eidentic:fn") as a function reference, which
    // is exactly what `defaultStoreFns()` / `defaultVectorFns()` produce.
    query: (fn, args) => t.query(fn as never, args as never),
    mutation: (fn, args) => t.mutation(fn as never, args as never),
    action: (fn, args) => t.action(fn as never, args as never),
  };
}
