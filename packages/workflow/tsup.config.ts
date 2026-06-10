import { defineConfig } from "tsup";
import { fixNodeProtocol } from "../../scripts/tsup-node-protocol.mjs";

export default defineConfig({
  onSuccess: async () => {
    await fixNodeProtocol("dist");
  },
});
