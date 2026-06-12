import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Standalone config for `pnpm --filter @eidentic/convex test`. convex-test runs in the Convex
 * runtime, so the test environment is `edge-runtime` (devDependency `@edge-runtime/vm`). The
 * source is consumed directly via aliases so no build step is needed before testing.
 *
 * NOTE: when running from the monorepo root (`vitest run`), the root vitest.config.ts is used
 * instead; these test files carry a `// @vitest-environment edge-runtime` docblock so they still
 * run under the Convex runtime there (the root config defaults to `node`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@eidentic/types/testing": root("../types/src/testing.ts"),
      "@eidentic/types": root("../types/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
