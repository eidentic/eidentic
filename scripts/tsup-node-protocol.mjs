// Post-build codemod: re-add the `node:` prefix to Node built-in imports.
//
// Our source already imports built-ins as `node:crypto` etc., but tsup adds the
// bare names (`crypto`) to esbuild's `external` array, and esbuild emits matched
// externals in their bare form — stripping the prefix from the output. Node and
// Bun accept the bare form, but Deno (and some edge runtimes) require the
// explicit `node:` prefix and otherwise fail at load time:
//   error: Import "crypto" not a dependency. add a "node:" prefix.
//
// An esbuild onResolve plugin can't fix this: paths in esbuild's `external`
// array bypass plugin resolution. So we rewrite the emitted specifiers directly.
// Wired into each package via its tsup.config.ts `onSuccess` hook, which runs in
// the package directory after a successful build.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs",
  "http", "http2", "https", "inspector", "module", "net", "os", "path",
  "perf_hooks", "process", "punycode", "querystring", "readline", "repl",
  "stream", "string_decoder", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
];

// `crypto`, `fs/promises`, … — bare or with one subpath, only as the specifier
// of an `import ... from "x"`, `import "x"`, dynamic `import("x")`, or
// `require("x")`. The leading delimiter (`"` or `(`) plus the trailing quote
// pin it to a module specifier, never an arbitrary string.
const BUILTIN_ALT = NODE_BUILTINS.join("|");
const SPEC = String.raw`(?<pre>(?:from\s*|import\s*|require\s*)\(?\s*)(?<q>["'])(?<mod>(?:${BUILTIN_ALT})(?:\/[a-z_][a-z0-9_./-]*)?)\k<q>`;
const RE = new RegExp(SPEC, "g");

/** Rewrite bare built-in specifiers to `node:`-prefixed in every build output. */
export async function fixNodeProtocol(distDir = "dist") {
  let entries;
  try {
    entries = await readdir(distDir, { withFileTypes: true, recursive: true });
  } catch {
    return; // no dist (e.g. dts-only / ui-only package) — nothing to do
  }
  await Promise.all(
    entries
      .filter((e) => e.isFile() && /\.(js|cjs|mjs)$/.test(e.name))
      .map(async (e) => {
        const file = join(e.parentPath ?? e.path ?? distDir, e.name);
        const src = await readFile(file, "utf8");
        const out = src.replace(RE, (_m, pre, q, mod) => `${pre}${q}node:${mod}${q}`);
        if (out !== src) await writeFile(file, out);
      }),
  );
}
