import { defineConfig } from "tsup";
import { fixNodeProtocol } from "../../scripts/tsup-node-protocol.mjs";

// Entry/format/dts come from the `build` script's CLI flags. After the build,
// re-add the `node:` prefix esbuild stripped from built-in imports, so the dist
// loads on Deno and other runtimes that require it. See the codemod for why a
// plugin can't do this.
export default defineConfig({
  onSuccess: async () => {
    await fixNodeProtocol("dist");
  },
});
