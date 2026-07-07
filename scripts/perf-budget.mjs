#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const root = process.cwd();

const budgets = [
  { name: "@eidentic/core", file: "packages/core/dist/index.js", gzipKb: 40 },
  { name: "@eidentic/model", file: "packages/model/dist/index.js", gzipKb: 12 },
  { name: "@eidentic/memory", file: "packages/memory/dist/index.js", gzipKb: 20 },
  { name: "@eidentic/sqlite", file: "packages/sqlite/dist/index.js", gzipKb: 8 },
  { name: "@eidentic/server", file: "packages/server/dist/index.js", gzipKb: 16 },
  { name: "@eidentic/tools", file: "packages/tools/dist/index.js", gzipKb: 14 },
  { name: "@eidentic/types", file: "packages/types/dist/index.js", gzipKb: 4 },
  { name: "eidentic", file: "packages/umbrella/dist/index.js", gzipKb: 3 },
  { name: "eidentic/testing", file: "packages/umbrella/dist/testing.js", gzipKb: 12 },
];

function size(file) {
  const abs = join(root, file);
  if (!existsSync(abs)) throw new Error(`missing built file: ${file}. Run pnpm -r build first.`);
  const raw = statSync(abs).size;
  const gzip = gzipSync(readFileSync(abs)).byteLength;
  return { raw, gzip };
}

function kb(n) {
  return n / 1024;
}

let failed = false;
const rows = [];

for (const budget of budgets) {
  const { raw, gzip } = size(budget.file);
  const gzipKb = kb(gzip);
  const ok = gzipKb <= budget.gzipKb;
  rows.push({
    package: budget.name,
    raw: `${kb(raw).toFixed(1)} KB`,
    gzip: `${gzipKb.toFixed(1)} KB`,
    budget: `${budget.gzipKb.toFixed(1)} KB`,
    ok: ok ? "yes" : "NO",
  });
  if (!ok) failed = true;
}

const studioAssets = join(root, "packages/studio/ui/dist/assets");
if (existsSync(studioAssets)) {
  const jsAssets = readdirSync(studioAssets).filter((name) => name.endsWith(".js"));
  for (const asset of jsAssets) {
    const rel = `packages/studio/ui/dist/assets/${asset}`;
    const { raw, gzip } = size(rel);
    const gzipKb = kb(gzip);
    const budgetKb = 90;
    const ok = gzipKb <= budgetKb;
    rows.push({
      package: "@eidentic/studio ui",
      raw: `${kb(raw).toFixed(1)} KB`,
      gzip: `${gzipKb.toFixed(1)} KB`,
      budget: `${budgetKb.toFixed(1)} KB`,
      ok: ok ? "yes" : "NO",
    });
    if (!ok) failed = true;
  }
}

console.table(rows);

if (failed) {
  console.error("Performance budget failed.");
  process.exit(1);
}

console.log("Performance budget passed.");
