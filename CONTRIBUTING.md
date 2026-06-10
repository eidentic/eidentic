# Contributing to Eidentic

Eidentic is an open-source, TypeScript-first SDK for building production AI agents. This
guide covers local setup and workflow conventions.

## Prerequisites

- **Node.js** ≥ 22.13 (CI runs on 22 and 24)
- **pnpm** 10 (`corepack enable` will provision the version pinned in `package.json`)
- A C toolchain for native modules (`better-sqlite3` compiles on install; on macOS install
  Xcode CLT, on Linux `build-essential` + `python3`)

## Setup

```bash
pnpm install          # installs deps and compiles native addons
pnpm -r build         # build all packages (emits dist/)
npx vitest run        # run the full test suite
pnpm -r typecheck     # typecheck every package
```

Run the end-to-end demo (no API key needed — uses a scripted mock model):

```bash
pnpm --filter eidentic-examples hello
```

> **Note on native-addon examples:** some examples (e.g. `hello:stateful`, `hello:stream`,
> `hello:memory`) use `SqliteStore` which depends on the `better-sqlite3` native addon.
> These require a real Node.js process (not tsx ESM mode with `--conditions`) and a
> compiled native module (`pnpm install` builds it automatically on supported platforms).
> If you see `Dynamic require of "better-sqlite3" is not supported`, run those examples
> with `node --loader tsx` or build the packages first with `pnpm -r build`.

## Repository layout

```
packages/        32 published packages (see root README for full list)
  types/         @eidentic/types   — zero-dep contracts, message protocol, ports, test fakes
  core/          @eidentic/core    — agent loop, tools, session, Agent
  model/         @eidentic/model   — ModelPort on Vercel AI SDK v6
  sqlite/        @eidentic/sqlite  — StorePort on better-sqlite3
  memory/        @eidentic/memory  — four-tier memory engine
  … (see packages/)
examples/        runnable demos (hello-*.ts, one per feature)
docs/
  design/        architecture spec — sections 00–20 plus master-design.md
  BENCHMARKS.md  methodology and reproducible numbers
  DEPLOYMENT.md  Node, Docker, edge, Next.js deployment guide
  RUNTIMES.md    runtime compatibility matrix
  TESTING.md     feature tour — run every example
```

The architecture and every locked decision live in [`docs/design`](docs/design/master-design.md).
Start with [`00-decisions.md`](docs/design/00-decisions.md).

## Workflow conventions

- **Trunk-based.** `main` is the single source of truth and is always releasable. Branch off
  `main` for every change.
- **Branch naming:** `feat/<short-desc>`, `fix/<short-desc>`, `docs/<short-desc>`,
  `refactor/<short-desc>`, `chore/<short-desc>`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat(core): ...`,
  `fix(memory): ...`, `docs: ...`, `refactor: ...`, `chore: ...`.
- **Pull requests** target `main`; CI (build · test · typecheck on Node 22 & 24) must be green.
- **TDD:** write the failing test first, then the implementation. Every behavior change ships
  with a test.
- **Changesets:** for any change to a published `@eidentic/*` package, run `pnpm changeset` and
  describe the change + bump level. Releases are versioned from accumulated changesets.

## Design principles (the short version)

Composable / no lock-in · stable semver API · production fundamentals built in (durability,
observability, cost control, security) · transparent cost · OSI license (Apache-2.0). The full
constitution is in [`01-vision-principles.md`](docs/design/01-vision-principles.md).

## Reporting issues

Open an issue with a minimal reproduction. Security-sensitive reports: please disclose
privately rather than in a public issue.
