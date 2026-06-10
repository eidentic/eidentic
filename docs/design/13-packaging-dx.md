# 13. Packaging & DX

[← 12. Persistence & Data Model](12-persistence-data-model.md) · [Index](master-design.md) · Next: [14. Traceability Matrix →](14-traceability-matrix.md)

The research is unambiguous that **DX and stability decide adoption** more than features:
near-weekly breakage, monorepo brokenness, 90 MB bundles, and `npm audit fix`
self-sabotage are cited more than any missing capability. Packaging is a first-class design
concern.

## 13.1 Monorepo toolchain (2026 standard)

- **pnpm** workspaces (v10+) — deterministic, fast, correct symlinks.
- **Turborepo** — dependency-graph task orchestration + remote cache.
- **tsup** (esbuild) — dual **ESM + CJS** output with `.d.ts`, per-package.
- **Changesets** — PR-based changelogs, coordinated versioning across packages.
- **TypeScript** strict, `moduleResolution: bundler`, ES2022 target.

## 13.2 Packages & versioning policy

**Naming convention (locked, §0-A):** packages are **single-word**, scoped `@eidentic/*`, with no
implementation-leaking prefixes (never `store-sqlite`, `model-aisdk`, `vector-lance`, `adapter-*`).
Two kinds: **capability packages** (core SDK concepts / single-canonical) are named by the concept;
**adapter packages** (one of several interchangeable port implementations) are named by their concrete
technology. For example: `@eidentic/sqlite` (not `store-sqlite`), `@eidentic/postgres` (not `store-pg`),
`@eidentic/lancedb` (not `vector-lance`), `@eidentic/model` (not `model-aisdk`).

Packages (§2.2, verified stack in §0):
- **Capability:** `@eidentic/types`, `core`, `memory`, `skills`, `multi-agent`, `model`, `mcp`, `a2a`,
  `durable`, `sandbox`, `vector`, `observability`, `governance`, `server`.
- **Adapters (by tech):** `sqlite` (better-sqlite3, FTS5 — embedded default), `libsql`, `postgres`,
  `lancedb`, `qdrant`, `cohere` (rerank), `e2b`, `microsandbox`, `restate`, `temporal`, `dbos`,
  `langfuse`, `otel`, `better-auth`, `stack-auth`.
- Plus the `eidentic` CLI + `create-eidentic`.

Embedded default store = **better-sqlite3** (`node:sqlite` lacks FTS5); durable default = **in-house
journal**; build = pnpm + Turborepo + **tsup** (→ tsdown at v1.0) + Changesets; **Node 22 min / 24
recommended**. All auth adapters are MIT/Apache-2.0 — never behind a commercial license.

**Stability policy (Constitution #2):**

- Strict **semver**. *No breaking change in minor or patch* — across the whole 1.x line.
- Breaking changes only in majors, each with a **codemod** (`npx @eidentic/codemod`).
- A documented **deprecation policy**: a feature is deprecated for ≥1 minor with warnings and a
  migration note before removal in the next major.
- **Granular subpath exports** + `sideEffects: false` everywhere; the default `@eidentic/core`
  bundle pulls **no** heavy optional deps (in-memory store/vector fakes only). Storage/vector/
  sandbox are separate installs, keeping serverless bundles small.

## 13.3 Scaffolding & CLI

```bash
npm create eidentic@latest          # interactive: pick adapters, mode, example
eidentic dev                        # run + dev studio (local trace UI)
eidentic build                      # bundle for deploy (serverless/edge/server)
eidentic studio                     # visual: sessions, memory blocks, context window, traces
eidentic doctor                     # environment + adapter diagnostics (a DX win)
eidentic bench memory               # run memory benchmark harness (§6.10)
```

`create-eidentic` generates a working, infra-free starter (libSQL + in-memory vector) so the
first run needs zero external services — the <5-minute success criterion.

## 13.4 The dev studio (transparency, free)

A local, self-hostable studio (no paid tier gate) that visualizes: the session event log,
**the exact context window** at each step, memory blocks + fill ratios + history, live
traces with cost and KV-cache hit-rate, and replay/time-travel. Reads OTel + the event log;
ships with the OSS repo.

## 13.5 Documentation discipline

The cited #1 docs complaint is "once past basic agents, you read source code." Eidentic docs
must cover the **non-trivial path** from day one: production memory config, Postgres/pgvector
setup, serverless/edge deploy, multi-agent budgets, security hardening, and migration guides.
Every public API has a runnable example. Docs are versioned with releases (no doc/version drift).

## 13.6 Runtime & deployment targets

Embedded library (Node 22+/Bun/Deno), serverless (Vercel/Netlify/Lambda), edge-aware
(Cloudflare Workers — no hard Node-only deps in core; stateless transport for MCP/server),
and the `@eidentic/server` (Hono) for agents-as-a-service. The same code; deployment is an
adapter + config choice.

## 13.7 Security hygiene of the toolchain

- No transitive malware-flagged dep cascades in `create-eidentic` — minimal, audited
  dependency tree; CI fails on advisories.
- `npm audit fix --force` must never downgrade to a broken version — pinned, tested ranges.
- Supply-chain: signed releases, provenance attestation (npm provenance), lockfile integrity.

## 13.8 Python SDK (designed-for, later)

Not built first (non-goal §1.6), but the architecture anticipates it: the wire protocol
(§3.2) and REST API (`@eidentic/server`) are language-neutral, so a Python client (and
eventually a native Python core sharing the same `types`/protocol) can follow without redesign.

## 13.9 Traceability

- Breaking changes / churn → §13.2 strict semver + codemods + deprecation policy.
- 90 MB serverless bundle → §13.2 subpath exports, separate adapter packages.
- Monorepo/workspace pain → first-class TS path-alias/workspace support in the bundler.
- Docs "read the source" → §13.5 non-trivial-path docs + runnable examples.
- Paid-tier debugging barrier → §13.4 free local studio.
- Malware-flagged deps / audit-fix footgun → §13.7 toolchain hygiene.
