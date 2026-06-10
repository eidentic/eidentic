import { defineConfig } from "tsup";
import { fixNodeProtocol } from "../../scripts/tsup-node-protocol.mjs";

// Re-add the `node:` prefix esbuild strips from built-in imports, so the dist
// loads on Deno and other runtimes that require it. See the codemod for why a
// plugin can't do this.
const restoreNodeProtocol = async () => {
  await fixNodeProtocol("dist");
};

export default defineConfig([
  // Library bundle (index) — ESM + CJS + types
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
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
