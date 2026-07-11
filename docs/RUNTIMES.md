# Runtime & Package Manager Compatibility

## Package managers

All standard packages install cleanly with npm, pnpm, yarn, and Bun. The `create-eidentic` scaffolder and `eidentic init` auto-detect the package manager in use.

| PM | Status |
|---|---|
| npm | Verified (CI) |
| pnpm | Verified (CI) |
| yarn | Standard — lightly tested |
| bun | Standard — lightly tested |

## Runtime matrix

| Runtime | Core | `@eidentic/sqlite` | Recommended store | Notes |
|---|---|---|---|---|
| **Node 22 / 24** | Full — CI verified | Full | `SqliteStore` or any store | All packages work. CI runs on Node 22 and 24. |
| **Bun** | Full — CI smoke verified | Builds if native addon compiles | `SqliteStore` (if addon built) or `@eidentic/libsql` / `@eidentic/postgres` | Core + pure-JS stores run without Node.js. `better-sqlite3` native build succeeds on most Bun versions. |
| **Deno** | Core — CI smoke verified (blocking) | Not recommended | `@eidentic/libsql` or `@eidentic/postgres` | Import `@eidentic/core` via npm specifiers (`npm:@eidentic/core`) or node-compat mode. All built-in imports carry the `node:` prefix Deno requires, so core loads cleanly. `better-sqlite3` native addon is not available on Deno. |
| **Edge / Workers** | Core + HTTP stores | Not available | `@eidentic/libsql` or `@eidentic/postgres` | No native addons, no `node:fs`. Use à-la-carte packages (see below). |

## Key rule: safe imports everywhere

Since `@eidentic/sqlite` v0.1 (this release), **importing the package — or the `eidentic` umbrella which re-exports it — does not load `better-sqlite3`**. The native addon is only required at `new SqliteStore()` construction time. This means:

```ts
// Safe on any runtime — no native addon loaded:
import { Agent } from "eidentic";

// Only this requires better-sqlite3 to be present:
const store = new SqliteStore();
```

If `better-sqlite3` is not available, constructing `SqliteStore` throws a descriptive error pointing to the alternative stores.

## Edge-safe à-la-carte setup (Deno / Workers)

For Deno, Cloudflare Workers, or other edge runtimes, skip the `eidentic` umbrella and compose directly:

```ts
import { Agent } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { LibsqlStore } from "@eidentic/libsql"; // or PostgresStore from @eidentic/postgres
```

These packages are pure-JS / HTTP-only — no native addons, no `node:fs`.

## Node built-ins used per package

Packages that use `node:fs` or other Node-only builtins work on **Node and Bun** and on **Deno with `--allow-read`/`--allow-write`** but are **not edge-safe**:

| Package | Node builtins | Edge-safe? |
|---|---|---|
| `@eidentic/core` | `node:crypto` (hashing) | Yes (Deno / Workers support `node:crypto`) |
| `@eidentic/types` | none | Yes |
| `@eidentic/model` | none | Yes |
| `@eidentic/memory` | none | Yes |
| `@eidentic/libsql` | none (HTTP) | Yes |
| `@eidentic/postgres` | none (HTTP) | Yes |
| `@eidentic/convex` | none (HTTP) | Yes |
| `@eidentic/server` | `node:http` / `node:fs` | Node / Bun only |
| `@eidentic/sqlite` | native addon | Node / Bun only |
| `@eidentic/skills` | `node:fs`, `node:child_process` | Node / Bun only |
| `@eidentic/tools` (fs-tools) | `node:fs` | Node / Bun / Deno-with-perms |
| `@eidentic/cli` | `node:fs`, `node:path`, … | Node / Bun only |
| `@eidentic/bench` | `node:fs` | Node / Bun only |
| `@eidentic/eval` | `node:fs` | Node / Bun only |
| `@eidentic/a2a` | `node:http` | Node / Bun only |
| `@eidentic/mcp` (host) | `node:child_process` | Node / Bun only |

## CI cross-runtime smoke

The CI (`cross-runtime.yml`) runs `scripts/runtime-smoke.mjs` — a self-contained smoke that imports the built dist via relative paths, constructs a `MockModel` + `InMemoryStore` agent (no native addon), runs one query, and asserts `subtype: "success"`. This proves the core is importable and functional on each runtime:

- **Node 22**: verified, blocking
- **Bun**: verified, blocking
- **Deno**: verified, blocking (`--allow-read --allow-env`)

### The `node:` prefix

Deno (and some edge runtimes) reject bare built-in imports like `import "crypto"` — they require the explicit `node:crypto` form. Our source already uses `node:` everywhere, but tsup/esbuild strips the prefix from its output when it externalises built-ins. A post-build codemod (`scripts/tsup-node-protocol.mjs`, wired into each package's `tsup.config.ts` via `onSuccess`) restores the prefix in every emitted `.js`/`.cjs`, keeping the dist portable. The Deno smoke job guards against regressions.
