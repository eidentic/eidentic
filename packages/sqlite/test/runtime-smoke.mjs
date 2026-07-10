import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function smoke(Store) {
  const store = new Store(":memory:");
  await store.migrate();
  await store.close();
}

const esm = await import("../dist/index.js");
await smoke(esm.SqliteStore);

const cjs = require("../dist/index.cjs");
await smoke(cjs.SqliteStore);

process.stdout.write("sqlite dist ESM+CJS smoke passed\n");
