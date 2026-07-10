#!/usr/bin/env node

/**
 * Pack every publishable workspace package, install the tarballs into an isolated consumer, and
 * exercise the published runtime/type surfaces. This deliberately avoids workspace symlinks: the
 * artifacts under test are the same files and export maps users receive from a registry.
 *
 * The install is offline. CI's normal workspace install primes pnpm's content-addressable store;
 * this gate must never fetch a package or use project credentials.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const KEEP = process.env.KEEP_PACKED_SMOKE === "1";
const MANIFESTS_ONLY = process.argv.includes("--manifests-only");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...(options.env ?? {}) },
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return result.stdout ?? "";
}

function packageDirectories() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) }))
    .filter(({ manifest }) => manifest.private !== true && typeof manifest.name === "string")
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Resolve third-party runtime/peer packages from the already-installed workspace. `link:` keeps
 * this pre-publish smoke genuinely offline even when the local lockfile contains a version that
 * registry metadata does not know about yet. Workspace packages themselves are still consumed
 * exclusively from their packed tarballs.
 */
function installedExternalPackages(packages) {
  const workspaceNames = new Set(packages.map(({ manifest }) => manifest.name));
  const resolved = new Map();
  for (const { dir, manifest } of packages) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (workspaceNames.has(name) || name === "pdf-parse") continue;
        const installed = join(dir, "node_modules", ...name.split("/"));
        if (!existsSync(installed)) {
          // Peers belong to the application. Exercise installed peers when the workspace has them,
          // but do not fetch a framework solely for this gate (for example Next.js, whose peer is
          // type/documentation-only in @eidentic/nextjs's root module).
          const optional = field === "optionalDependencies" || field === "peerDependencies";
          if (!optional) {
            throw new Error(`${manifest.name}: required external package ${name} is not installed; run pnpm install before test:packed`);
          }
          continue;
        }
        const target = realpathSync(installed);
        const previous = resolved.get(name);
        if (previous !== undefined && previous !== target) {
          throw new Error(`${name}: packed smoke found conflicting installed peer/runtime versions (${previous}, ${target})`);
        }
        resolved.set(name, target);
      }
    }
  }
  return Object.fromEntries([...resolved].map(([name, path]) => [name, `link:${path}`]));
}

function exportEntries(manifest) {
  if (!manifest.exports || typeof manifest.exports !== "object") return [];
  return Object.entries(manifest.exports).filter(([key]) => key === "." || key.startsWith("./"));
}

function declarationFor(runtimeTarget, extension) {
  if (typeof runtimeTarget !== "string") return undefined;
  return runtimeTarget.replace(/\.(?:c?js|mjs)$/u, extension);
}

function assertDualPackageExports(packages, packedFilesByName) {
  const failures = [];
  let checkedEntries = 0;

  for (const { manifest } of packages) {
    for (const [subpath, target] of exportEntries(manifest)) {
      if (!target || typeof target !== "object" || !("require" in target)) continue;
      checkedEntries++;

      const importTarget = target.import;
      const requireTarget = target.require;
      if (!importTarget || typeof importTarget !== "object") {
        failures.push(`${manifest.name}${subpath === "." ? "" : subpath.slice(1)}: import must have nested types/default conditions`);
        continue;
      }
      if (!requireTarget || typeof requireTarget !== "object") {
        failures.push(`${manifest.name}${subpath === "." ? "" : subpath.slice(1)}: require must have nested types/default conditions`);
        continue;
      }

      const expectedImportTypes = declarationFor(importTarget.default, ".d.ts");
      const expectedRequireTypes = declarationFor(requireTarget.default, ".d.cts");
      if (importTarget.types !== expectedImportTypes) {
        failures.push(`${manifest.name}${subpath}: import.types must be ${expectedImportTypes ?? "derived from import.default"}`);
      }
      if (requireTarget.types !== expectedRequireTypes) {
        failures.push(`${manifest.name}${subpath}: require.types must be ${expectedRequireTypes ?? "derived from require.default"}`);
      }

      for (const declared of [importTarget.types, requireTarget.types]) {
        if (typeof declared !== "string") continue;
        const packageRelative = declared.replace(/^\.\//u, "");
        const packedFiles = packedFilesByName?.get(manifest.name);
        if (packedFiles) {
          if (!packedFiles.has(packageRelative)) {
            failures.push(`${manifest.name}${subpath}: packed artifact omits ${declared}`);
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`dual-package export validation failed:\n- ${failures.join("\n- ")}`);
  }
  if (checkedEntries === 0) throw new Error("dual-package export validation found no CommonJS exports");
  return checkedEntries;
}

function assertExecutableMetadata(packages, consumerRoot) {
  const expected = new Map([
    ["@eidentic/cli", true],
    ["create-eidentic", true],
    ["eidentic", ["./dist/cli.js"]],
  ]);

  for (const { manifest } of packages) {
    if (!expected.has(manifest.name)) continue;
    const wanted = expected.get(manifest.name);
    if (JSON.stringify(manifest.sideEffects) !== JSON.stringify(wanted)) {
      throw new Error(`${manifest.name}: sideEffects must be ${JSON.stringify(wanted)}`);
    }
    for (const target of Object.values(manifest.bin ?? {})) {
      const installed = join(consumerRoot, "node_modules", ...manifest.name.split("/"), target.replace(/^\.\//u, ""));
      if (!existsSync(installed) || !statSync(installed).isFile()) {
        throw new Error(`${manifest.name}: packed bin target is missing: ${target}`);
      }
      if (!readFileSync(installed, "utf8").startsWith("#!")) {
        throw new Error(`${manifest.name}: packed bin target has no shebang: ${target}`);
      }
    }
  }
}

function packAll(packages, destination) {
  const packed = [];
  for (const { dir, manifest } of packages) {
    const safeName = manifest.name.replace(/^@/u, "").replaceAll("/", "-");
    const output = join(destination, `${safeName}-${manifest.version}.tgz`);
    const raw = run(PNPM, ["pack", "--out", output, "--json"], { cwd: dir, capture: true });
    const description = JSON.parse(raw);
    packed.push({
      name: manifest.name,
      filename: description.filename,
      files: new Set(description.files.map((entry) => entry.path)),
    });
  }
  return packed;
}

function specFor(name, subpath) {
  return subpath === "." ? name : `${name}/${subpath.slice(2)}`;
}

function typeFixture(packages, condition) {
  const imports = [];
  let index = 0;
  for (const { manifest } of packages) {
    for (const [subpath, target] of exportEntries(manifest)) {
      if (!target || typeof target !== "object" || !(condition in target)) continue;
      imports.push(`import type * as Package${index++} from ${JSON.stringify(specFor(manifest.name, subpath))};`);
    }
  }
  imports.push("export {};", "");
  return imports.join("\n");
}

function runtimeFixture(packageNames, moduleKind) {
  const imports = JSON.stringify(packageNames);
  const loadAll = moduleKind === "esm"
    ? `await Promise.all(PACKAGES.map((name) => import(name)));`
    : `for (const name of PACKAGES) require(name);`;
  const load = moduleKind === "esm"
    ? {
        core: `await import("@eidentic/core")`,
        types: `await import("@eidentic/types")`,
        testing: `await import("@eidentic/types/testing")`,
        sqlite: `await import("@eidentic/sqlite")`,
        rag: `await import("@eidentic/rag")`,
      }
    : {
        core: `require("@eidentic/core")`,
        types: `require("@eidentic/types")`,
        testing: `require("@eidentic/types/testing")`,
        sqlite: `require("@eidentic/sqlite")`,
        rag: `require("@eidentic/rag")`,
      };
  const wrapperStart = moduleKind === "esm" ? "" : "(async () => {\n";
  const wrapperEnd = moduleKind === "esm" ? "" : "\n})().catch((error) => { console.error(error); process.exit(1); });\n";

  return `${wrapperStart}const PACKAGES = ${imports};
${loadAll}

const { Agent } = ${load.core};
const { textBlock } = ${load.types};
const { InMemoryStore, MockModel } = ${load.testing};
const store = new InMemoryStore();
await store.migrate();
const agent = new Agent({
  id: "packed-consumer",
  instructions: "Reply once.",
  model: new MockModel([{ content: [textBlock("packed ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
  store,
});
let terminal;
for await (const event of agent.query("hello", { sessionId: "packed-session" })) {
  if (event.type === "result") terminal = event;
}
if (terminal?.subtype !== "success" || terminal.output !== "packed ok") {
  throw new Error("packed agent smoke failed: " + JSON.stringify(terminal));
}

const { SqliteStore } = ${load.sqlite};
const sqlite = new SqliteStore(":memory:");
await sqlite.migrate();
await sqlite.createSession({ id: "packed-sqlite", agentId: "packed", createdAt: "2026-07-10T00:00:00.000Z" });
if ((await sqlite.getSession("packed-sqlite"))?.agentId !== "packed") {
  throw new Error("packed SQLite constructor/migration smoke failed");
}

const { loadPdf } = ${load.rag};
const pdf = await loadPdf(Buffer.from("fake-pdf"));
if (pdf.text !== "packed pdf ok" || pdf.metadata.pages !== 1) {
  throw new Error("packed RAG PDF smoke failed: " + JSON.stringify(pdf));
}

console.log("packed ${moduleKind.toUpperCase()} runtime smoke OK");${wrapperEnd}`;
}

const packages = packageDirectories();

if (MANIFESTS_ONLY) {
  const count = assertDualPackageExports(packages);
  console.log(`packed manifest preflight OK (${packages.length} packages, ${count} CommonJS export entries)`);
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "eidentic-packed-consumer-"));
try {
  const tarballs = join(tempRoot, "tarballs");
  const consumer = join(tempRoot, "consumer");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  const packed = packAll(packages, tarballs);
  const packedFilesByName = new Map(packed.map((entry) => [entry.name, entry.files]));
  const cjsExportCount = assertDualPackageExports(packages, packedFilesByName);

  const fakePdf = join(consumer, "fixtures", "pdf-parse");
  mkdirSync(fakePdf, { recursive: true });
  writeJson(join(fakePdf, "package.json"), { name: "pdf-parse", version: "1.1.1", main: "index.cjs" });
  writeFileSync(join(fakePdf, "index.cjs"), "module.exports = async () => ({ text: 'packed pdf ok', numpages: 1 });\n");

  const dependencies = Object.fromEntries(packed.map(({ name, filename }) => [name, `file:${filename}`]));
  const externalPackages = installedExternalPackages(packages);
  Object.assign(dependencies, externalPackages);
  // A tarball's internal workspace dependencies have already been rewritten by pnpm to their
  // exact publish versions. Those versions may not exist on the registry yet (this is commonly
  // the pre-publish gate), so force every occurrence to the sibling tarball under test.
  const workspaceOverrides = { ...dependencies };
  dependencies["pdf-parse"] = "file:./fixtures/pdf-parse";
  workspaceOverrides["pdf-parse"] = "file:./fixtures/pdf-parse";
  writeJson(join(consumer, "package.json"), {
    name: "eidentic-packed-consumer",
    private: true,
    type: "module",
    dependencies,
    pnpm: {
      overrides: workspaceOverrides,
      onlyBuiltDependencies: ["better-sqlite3"],
    },
  });
  writeFileSync(join(consumer, ".npmrc"), "auto-install-peers=false\n");

  run(PNPM, ["install", "--offline", "--frozen-lockfile=false"], { cwd: consumer, capture: true });
  assertExecutableMetadata(packages, consumer);

  const dualRoots = packages
    .filter(({ manifest }) => {
      const root = manifest.exports?.["."];
      return root && typeof root === "object" && "require" in root;
    })
    .map(({ manifest }) => manifest.name);
  const esmRoots = packages
    .filter(({ manifest }) => !["@eidentic/cli", "create-eidentic"].includes(manifest.name))
    .filter(({ manifest }) => manifest.exports?.["."] !== undefined)
    .map(({ manifest }) => manifest.name);

  writeFileSync(join(consumer, "smoke.mjs"), runtimeFixture(esmRoots, "esm"));
  writeFileSync(join(consumer, "smoke.cjs"), runtimeFixture(dualRoots, "cjs"));
  run(process.execPath, ["smoke.mjs"], { cwd: consumer });
  run(process.execPath, ["smoke.cjs"], { cwd: consumer });

  writeFileSync(join(consumer, "consumer.mts"), typeFixture(packages, "import"));
  writeFileSync(join(consumer, "consumer.cts"), typeFixture(packages, "require"));
  writeJson(join(consumer, "tsconfig.nodenext.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      types: [],
    },
    files: ["consumer.mts"],
  });
  writeJson(join(consumer, "tsconfig.node16.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      types: [],
    },
    files: ["consumer.cts"],
  });
  run(PNPM, ["exec", "tsc", "-p", join(consumer, "tsconfig.nodenext.json")], { cwd: ROOT });
  run(PNPM, ["exec", "tsc", "-p", join(consumer, "tsconfig.node16.json")], { cwd: ROOT });

  console.log(
    `packed consumer gate OK (${packages.length} tarballs, ${cjsExportCount} CommonJS export entries, ESM/CJS runtime, NodeNext/Node16 types)`,
  );
} finally {
  if (KEEP) console.log(`KEEP_PACKED_SMOKE=1: retained ${tempRoot}`);
  else rmSync(tempRoot, { recursive: true, force: true });
}
