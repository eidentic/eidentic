#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const specArgIndex = args.findIndex((arg) => arg === "--package");
const packageSpec = specArgIndex >= 0 ? args[specArgIndex + 1] : "eidentic";

if (!packageSpec) {
  console.error("Usage: node scripts/fresh-install-smoke.mjs [--package <npm-spec-or-tarball>] [--keep]");
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const printable = [cmd, ...cmdArgs].join(" ");
  console.log(`$ ${printable}`);
  const result = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const dir = mkdtempSync(join(tmpdir(), "eidentic-fresh-"));

try {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", private: true }, null, 2));
  run("npm", ["install", packageSpec], { cwd: dir });
  writeFileSync(
    join(dir, "smoke.mjs"),
    `import { Agent, textBlock } from "eidentic";
import { InMemoryStore, MockModel } from "eidentic/testing";

const store = new InMemoryStore();
await store.migrate();

const agent = new Agent({
  id: "fresh-install",
  instructions: "Reply once.",
  model: new MockModel([{ content: [textBlock("fresh install ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
  store,
});

let result;
for await (const event of agent.query("hello", { sessionId: "fresh-install-s1" })) {
  if (event.type === "result") result = event;
}

if (!result || result.subtype !== "success" || result.output !== "fresh install ok") {
  console.error("fresh-install smoke FAILED", result);
  process.exit(1);
}
console.log("fresh-install smoke OK");
`,
  );
  run("node", ["smoke.mjs"], { cwd: dir });
  console.log(`Fresh install smoke passed in ${dir}`);
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
