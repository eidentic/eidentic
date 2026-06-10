---
title: Runtimes
description: Runtime and package manager compatibility matrix for Eidentic.
---

Eidentic is verified on Node, Bun, Deno, and edge runtimes. This page summarises what works where and how to set up each.

## Package managers

All packages install with npm, pnpm, yarn, and Bun. The `create-eidentic` scaffolder and `eidentic init` auto-detect the package manager in use.

| Package manager | Status |
|---|---|
| npm | Verified (CI) |
| pnpm | Verified (CI) |
| yarn | Supported — lightly tested |
| bun | Supported — lightly tested |

## Runtime matrix

| Runtime | Core | `@eidentic/sqlite` | Recommended store |
|---|---|---|---|
| **Node 22 / 24** | Full — CI verified | Full | `SqliteStore` or any store |
| **Bun** | Full — CI smoke verified | Builds if native addon compiles | `SqliteStore` (if addon built) or `@eidentic/libsql` / `@eidentic/postgres` |
| **Deno** | Core — CI smoke verified | Not recommended | `@eidentic/libsql` or `@eidentic/postgres` |
| **Edge / Workers** | Core + HTTP stores | Not available | `@eidentic/libsql` or `@eidentic/postgres` |

## Safe import rule

Importing `eidentic` or `@eidentic/sqlite` does **not** load `better-sqlite3`. The native addon is only required when `new SqliteStore()` is constructed. This means the umbrella package is safe to import on any runtime:

```ts
// Safe on any runtime — no native addon loaded at import time:
import { Agent } from "eidentic";

// Only this requires better-sqlite3 to be present:
const store = new SqliteStore();
```

If `better-sqlite3` is not available, constructing `SqliteStore` throws a descriptive error pointing to the alternative stores.

## Edge-safe à-la-carte setup

For Deno, Cloudflare Workers, or other edge runtimes, skip the `eidentic` umbrella and compose directly from the individual packages:

```ts
import { Agent } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { LibsqlStore } from "@eidentic/libsql"; // or PostgresStore from @eidentic/postgres
import { anthropic } from "@ai-sdk/anthropic";

const agent = new Agent({
  id: "edge-agent",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new LibsqlStore(process.env.LIBSQL_URL!),
});
```

`@eidentic/core`, `@eidentic/model`, `@eidentic/memory`, `@eidentic/libsql`, and `@eidentic/postgres` are pure-JS / HTTP-only — no native addons, no `node:fs`.

## Package edge-safety table

| Package | Node builtins | Edge-safe? |
|---|---|---|
| `@eidentic/core` | `node:crypto` (hashing) | Yes (Deno / Workers support `node:crypto`) |
| `@eidentic/types` | none | Yes |
| `@eidentic/model` | none | Yes |
| `@eidentic/memory` | none | Yes |
| `@eidentic/libsql` | none (HTTP) | Yes |
| `@eidentic/postgres` | none (HTTP) | Yes |
| `@eidentic/server` | `node:http` / `node:fs` | Node / Bun only |
| `@eidentic/sqlite` | native addon | Node / Bun only |
| `@eidentic/skills` | `node:fs`, `node:child_process` | Node / Bun only |
| `@eidentic/tools` (fs-tools) | `node:fs` | Node / Bun / Deno-with-perms |
| `@eidentic/cli` | `node:fs`, `node:path`, … | Node / Bun only |
| `@eidentic/e2b` | `node:http` | Node / Bun only |
| `@eidentic/mcp` (host) | `node:child_process` | Node / Bun only |

## Deno setup

Import via npm specifiers:

```ts
import { Agent } from "npm:@eidentic/core";
import { AIModel } from "npm:@eidentic/model";
import { LibsqlStore } from "npm:@eidentic/libsql";
```

Or use a `deno.json` import map:

```json
{
  "imports": {
    "@eidentic/core": "npm:@eidentic/core",
    "@eidentic/model": "npm:@eidentic/model",
    "@eidentic/libsql": "npm:@eidentic/libsql"
  }
}
```

All `node:` built-in imports in the Eidentic dist use the explicit `node:` prefix required by Deno.

Run with permissions:

```bash
deno run --allow-read --allow-env --allow-net my-agent.ts
```

## CI verification

The CI `cross-runtime.yml` workflow runs `scripts/runtime-smoke.mjs` — a self-contained smoke that imports the built dist, constructs an agent with `MockModel` + `InMemoryStore`, runs one query, and asserts `subtype: "success"`:

- **Node 22**: verified, blocking
- **Bun**: verified, blocking
- **Deno**: verified, blocking (`--allow-read --allow-env`)

## Performance

Framework overhead per agent turn across runtimes (pure framework cost — model latency not included):

| Runtime | Per-turn overhead | Cold turns / sec |
|---|---:|---:|
| Node 24 | ~0.012 ms | ~83,000 |
| Bun | ~0.012 ms | ~87,000 |
| Deno 2 | ~0.013 ms | ~75,000 |

Cold start (import time for `@eidentic/core` + `@eidentic/types`):

| Runtime | Import time |
|---|---:|
| Node 24 | 21–31 ms |
| Bun | 15–18 ms |
| Deno 2 | 12–16 ms |

See [docs/BENCHMARKS.md](https://github.com/eidentic/eidentic/blob/main/docs/BENCHMARKS.md) for the full benchmark methodology.
