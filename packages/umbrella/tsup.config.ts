import { defineConfig } from "tsup";
import { fixNodeProtocol } from "../../scripts/tsup-node-protocol.mjs";

// Re-add the `node:` prefix esbuild strips from built-in imports, so the dist
// loads on Deno and other runtimes that require it. See the codemod for why a
// plugin can't do this.
const restoreNodeProtocol = async () => {
  await fixNodeProtocol("dist");
};

export default defineConfig([
  // Library bundle (index) — ESM + types. AI SDK v7 is ESM-only, so the
  // umbrella package cannot safely expose a CommonJS entrypoint.
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: false,
    onSuccess: restoreNodeProtocol,
  },
  // CLI bundle — ESM only, shebang banner
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
    onSuccess: restoreNodeProtocol,
  },
]);
