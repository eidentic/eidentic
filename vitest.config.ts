import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@eidentic/types/testing": src("./packages/types/src/testing.ts"),
      "@eidentic/types": src("./packages/types/src/index.ts"),
      "@eidentic/sqlite": src("./packages/sqlite/src/index.ts"),
      "@eidentic/libsql": src("./packages/libsql/src/index.ts"),
      "@eidentic/core": src("./packages/core/src/index.ts"),
      "@eidentic/model": src("./packages/model/src/index.ts"),
      "@eidentic/memory": src("./packages/memory/src/index.ts"),
      "@eidentic/lancedb": src("./packages/lancedb/src/index.ts"),
      "@eidentic/transformers": src("./packages/transformers/src/index.ts"),
      "@eidentic/skills": src("./packages/skills/src/index.ts"),
      "@eidentic/e2b": src("./packages/e2b/src/index.ts"),
      "@eidentic/mcp": src("./packages/mcp/src/index.ts"),
      "@eidentic/a2a": src("./packages/a2a/src/index.ts"),
      "@eidentic/tools": src("./packages/tools/src/index.ts"),
      "@eidentic/rag": src("./packages/rag/src/index.ts"),
      "@eidentic/browser": src("./packages/browser/src/index.ts"),
      "@eidentic/prompts": src("./packages/prompts/src/index.ts"),
      "@eidentic/react": src("./packages/react/src/index.ts"),
      "@eidentic/eval": src("./packages/eval/src/index.ts"),
      "@eidentic/bench": src("./packages/bench/src/index.ts"),
      "@eidentic/postgres": src("./packages/postgres/src/index.ts"),
      "@eidentic/server": src("./packages/server/src/index.ts"),
      "@eidentic/nextjs": src("./packages/nextjs/src/index.ts"),
      "@eidentic/better-auth": src("./packages/better-auth/src/index.ts"),
      "@eidentic/studio": src("./packages/studio/src/index.ts"),
      "@eidentic/cli": src("./packages/cli/src/commands.ts"),
      "@eidentic/langfuse": src("./packages/langfuse/src/index.ts"),
      "@eidentic/workflow": src("./packages/workflow/src/index.ts"),
      eidentic: src("./packages/umbrella/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
    environment: "node",
    passWithNoTests: true,
  },
});
