#!/usr/bin/env node

import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The audit hardening deliberately put credential fingerprinting/redaction, multimodal
// validation, and replay/idempotency protections on Agent's default path. Preserve the old
// 40 KiB ceiling as the baseline and grant that security work a bounded 4 KiB (10%) allowance.
// The consumer and publish-footprint budgets below prevent that allowance from becoming a
// blanket excuse for unrelated growth.
const CORE_BASELINE_GZIP_KIB = 40;
const CORE_SECURITY_HEADROOM_GZIP_KIB = 4;

const artifactBudgets = [
  {
    name: "@eidentic/core full ESM runtime",
    file: "packages/core/dist/index.js",
    gzipKib: CORE_BASELINE_GZIP_KIB + CORE_SECURITY_HEADROOM_GZIP_KIB,
    budgetLabel: `${CORE_BASELINE_GZIP_KIB} + ${CORE_SECURITY_HEADROOM_GZIP_KIB} security`,
  },
  { name: "@eidentic/model", file: "packages/model/dist/index.js", gzipKib: 12 },
  { name: "@eidentic/memory", file: "packages/memory/dist/index.js", gzipKib: 20 },
  { name: "@eidentic/sqlite", file: "packages/sqlite/dist/index.js", gzipKib: 8 },
  { name: "@eidentic/server", file: "packages/server/dist/index.js", gzipKib: 16 },
  { name: "@eidentic/tools", file: "packages/tools/dist/index.js", gzipKib: 14 },
  { name: "@eidentic/types", file: "packages/types/dist/index.js", gzipKib: 4 },
  { name: "eidentic", file: "packages/umbrella/dist/index.js", gzipKib: 3 },
  { name: "eidentic/testing", file: "packages/umbrella/dist/testing.js", gzipKib: 12 },
];

// These are actual ESM consumer entry points, bundled and minified with all runtime dependencies.
// Fixed ceilings turn tree-shaking failures and dependency bloat into release-blocking failures.
const consumerBudgets = [
  {
    name: "@eidentic/core Agent consumer",
    source: 'import { Agent } from "./packages/core/dist/index.js"; export { Agent };',
    gzipKib: 92,
  },
  {
    name: "@eidentic/core boundary consumer",
    source:
      'import { sanitizeBoundaryValue } from "./packages/core/dist/index.js"; export { sanitizeBoundaryValue };',
    gzipKib: 1.25,
  },
];

function bytesToKib(bytes) {
  return bytes / 1024;
}

function requireBuiltFile(relativeFile) {
  const absoluteFile = join(root, relativeFile);
  if (!existsSync(absoluteFile)) {
    throw new Error(`missing built file: ${relativeFile}. Run pnpm -r build first.`);
  }
  const stats = statSync(absoluteFile);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`built artifact is not a non-empty regular file: ${relativeFile}`);
  }
  return absoluteFile;
}

function measureFile(relativeFile) {
  const contents = readFileSync(requireBuiltFile(relativeFile));
  return { raw: contents.byteLength, gzip: gzipSync(contents, { level: 9 }).byteLength };
}

function resolveEsbuild() {
  // tsup is the repository's pinned builder and already owns the compatible esbuild dependency.
  // Resolve through it instead of downloading or adding an independent tool to this gate.
  const require = createRequire(import.meta.url);
  const tsupRequire = createRequire(require.resolve("tsup/package.json"));
  const esbuild = tsupRequire("esbuild");
  if (typeof esbuild.build !== "function" || typeof esbuild.version !== "string") {
    throw new Error("the esbuild bundled with tsup is unavailable or invalid");
  }
  return esbuild;
}

async function measureConsumerBundle(esbuild, source, index) {
  const result = await esbuild.build({
    stdin: {
      contents: source,
      loader: "js",
      resolveDir: root,
      sourcefile: `perf-consumer-${index}.mjs`,
    },
    bundle: true,
    charset: "utf8",
    format: "esm",
    legalComments: "none",
    logLevel: "silent",
    minify: true,
    platform: "node",
    sourcemap: false,
    target: "node22",
    treeShaking: true,
    write: false,
  });
  if (result.outputFiles?.length !== 1) {
    throw new Error(`consumer bundle ${index} produced ${result.outputFiles?.length ?? 0} outputs; expected exactly one`);
  }
  const contents = result.outputFiles[0].contents;
  if (contents.byteLength === 0) throw new Error(`consumer bundle ${index} is empty`);
  return { raw: contents.byteLength, gzip: gzipSync(contents, { level: 9 }).byteLength };
}

function walkPublishEntry(packageDir, relativeEntry) {
  const absoluteEntry = join(packageDir, relativeEntry);
  if (!existsSync(absoluteEntry)) throw new Error(`publish entry is missing: ${relativeEntry}`);
  const stats = lstatSync(absoluteEntry);
  if (stats.isSymbolicLink()) throw new Error(`publish entry must not be a symbolic link: ${relativeEntry}`);
  if (stats.isFile()) return { bytes: stats.size, files: 1 };
  if (!stats.isDirectory()) throw new Error(`unsupported publish entry type: ${relativeEntry}`);

  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(absoluteEntry).sort()) {
    const nested = walkPublishEntry(packageDir, join(relativeEntry, name));
    bytes += nested.bytes;
    files += nested.files;
  }
  return { bytes, files };
}

function measurePublishFootprint(relativePackageDir) {
  const packageDir = join(root, relativePackageDir);
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${manifest.name ?? relativePackageDir}: package.json must declare a non-empty files allowlist`);
  }

  const entries = ["package.json", ...manifest.files];
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${manifest.name ?? relativePackageDir}: duplicate publish entries make the footprint ambiguous`);
  }

  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.startsWith("/") || entry.split(/[\\/]/u).includes("..")) {
      throw new Error(`${manifest.name ?? relativePackageDir}: unsafe publish entry ${JSON.stringify(entry)}`);
    }
    const measured = walkPublishEntry(packageDir, entry);
    bytes += measured.bytes;
    files += measured.files;
  }
  if (files === 0 || bytes === 0) throw new Error(`${manifest.name ?? relativePackageDir}: publish footprint is empty`);
  return { bytes, files };
}

function addRow(rows, measurement) {
  const ok = measurement.actualKib <= measurement.budgetKib;
  rows.push({
    metric: measurement.name,
    raw: measurement.rawKib === undefined ? "—" : `${measurement.rawKib.toFixed(1)} KiB`,
    measured: `${measurement.actualKib.toFixed(1)} KiB`,
    budget: measurement.budgetLabel ?? `${measurement.budgetKib.toFixed(1)} KiB`,
    ok: ok ? "yes" : "NO",
  });
  return ok;
}

let failed = false;
const rows = [];

for (const budget of artifactBudgets) {
  const { raw, gzip } = measureFile(budget.file);
  if (!addRow(rows, {
    name: budget.name,
    rawKib: bytesToKib(raw),
    actualKib: bytesToKib(gzip),
    budgetKib: budget.gzipKib,
    budgetLabel: budget.budgetLabel,
  })) failed = true;
}

const esbuild = resolveEsbuild();
for (const [index, budget] of consumerBudgets.entries()) {
  const { raw, gzip } = await measureConsumerBundle(esbuild, budget.source, index);
  if (!addRow(rows, {
    name: budget.name,
    rawKib: bytesToKib(raw),
    actualKib: bytesToKib(gzip),
    budgetKib: budget.gzipKib,
  })) failed = true;
}

// The complete published core install (both runtimes, both declaration formats, docs, license,
// and manifest) gets a separate 512 KiB ceiling. Unlike tarball compression, this byte count is
// stable across clocks/platforms and cannot hide growth behind improved compression ratios.
const corePublish = measurePublishFootprint("packages/core");
if (!addRow(rows, {
  name: `@eidentic/core publish footprint (${corePublish.files} files)`,
  actualKib: bytesToKib(corePublish.bytes),
  budgetKib: 512,
})) failed = true;

const studioAssets = join(root, "packages/studio/ui/dist/assets");
if (existsSync(studioAssets)) {
  const jsAssets = readdirSync(studioAssets).filter((name) => name.endsWith(".js")).sort();
  for (const asset of jsAssets) {
    const relativeFile = `packages/studio/ui/dist/assets/${asset}`;
    const { raw, gzip } = measureFile(relativeFile);
    if (!addRow(rows, {
      name: "@eidentic/studio UI",
      rawKib: bytesToKib(raw),
      actualKib: bytesToKib(gzip),
      budgetKib: 90,
    })) failed = true;
  }
}

console.table(rows);
console.log(`Tree-shaken consumer bundles built offline with esbuild ${esbuild.version}.`);

if (failed) {
  console.error("Performance budget failed.");
  process.exit(1);
}

console.log("Performance budget passed.");
