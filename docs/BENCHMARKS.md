# Eidentic benchmarks

Honest, reproducible performance numbers. As of **June 2026**, on a single machine
(Apple Silicon, arm64, 12 cores, Node v24.13.1).

> **What these are — and aren't.** Eidentic is pre-1.0. The numbers below are *framework
> overhead, cold-start, bundle size, and cross-runtime* measurements — the "production
> fundamentals" we claim. They are fully reproducible from this repo. The *memory-accuracy*
> numbers (LongMemEval / LoCoMo answer accuracy) require the licensed datasets and a real model
> run; the harness ships, but we have **not** published those numbers yet and will not fabricate
> them. See [Memory recall](#memory-recall) below.

## TL;DR

- **Framework overhead per agent turn: ~0.01 ms** (≈10–13 µs) — utterly dominated by model
  latency, which is 4–6 orders of magnitude larger. Eidentic adds essentially nothing to your
  per-request time.
- **Cold start (import the built SDK): 12–31 ms** across Node / Bun / Deno — cheap enough for
  serverless and edge.
- **Tiny install footprint:** `@eidentic/core` is **22.5 KB gzipped**; the `eidentic` umbrella
  entry is **0.6 KB**.
- **Verified on Node, Bun, and Deno** — the same numbers, same code, no per-runtime forks.

## Framework overhead

What does Eidentic *add* to one agent turn, independent of the model? We drive a `MockModel`
(instant response) over an in-memory store, so the measured time is pure framework cost:
agent construction, session creation, the ReAct loop, event-sourcing, cost preflight, the
compaction gate, and OpenTelemetry plumbing. Each turn uses a fresh agent + store, so history
depth stays constant (a realistic serverless/edge "cold turn").

| Runtime | Per-turn overhead (mean) | p50 | p95 | Cold turns / sec |
|---|---:|---:|---:|---:|
| Node 24 | 0.012 ms | 0.010 ms | 0.019 ms | ~83,000 |
| Bun     | 0.012 ms | 0.010 ms | 0.018 ms | ~87,000 |
| Deno 2  | 0.013 ms | 0.011 ms | 0.021 ms | ~75,000 |

*Measured over 3,000 iterations after warmup; stable across iteration counts (no accumulation
artifact). For context: a single real model call is typically 200–2,000 ms — so framework
overhead is ~0.001% of a real turn.*

**Reproduce:**

```bash
pnpm -r build
node scripts/bench-overhead.mjs 3000
bun  scripts/bench-overhead.mjs 3000
deno run --allow-read --allow-env scripts/bench-overhead.mjs 3000
```

## Cold start (import cost)

Time to dynamically import the built `@eidentic/core` + `@eidentic/types` dist:

| Runtime | Import time |
|---|---:|
| Node 24 | 21–31 ms |
| Bun     | 15–18 ms |
| Deno 2  | 12–16 ms |

This is the cold-start tax a serverless/edge function pays once per cold container. (Same
script as above; `importMs` field.)

## Bundle size

Gzipped size of each package's primary ESM bundle — what actually ships over the wire and
counts against an edge bundle budget:

| Package | Raw | Gzipped |
|---|---:|---:|
| `@eidentic/core` | 93.7 KB | **22.5 KB** |
| `@eidentic/model` | 52.2 KB | 6.7 KB |
| `@eidentic/tools` | 25.7 KB | 6.5 KB |
| `@eidentic/memory` | 24.2 KB | 7.2 KB |
| `@eidentic/sqlite` | 18.6 KB | 4.6 KB |
| `@eidentic/server` | 11.7 KB | 2.9 KB |
| `@eidentic/types` | 1.7 KB | 0.7 KB |
| `eidentic` (umbrella entry) | 1.8 KB | 0.6 KB |

You only pay for the adapters you import — the ports-and-adapters layout means a Postgres
deployment never bundles SQLite, an edge deployment never bundles native addons, etc.

## Cross-runtime

The framework runs identically on **Node, Bun, and Deno** — verified by a blocking CI smoke
(`scripts/runtime-smoke.mjs`) that constructs a real agent and asserts a successful run on
each. See the [runtime support matrix](RUNTIMES.md). Install works with **npm, pnpm, yarn,
and bun**.

## Memory recall

Eidentic's memory engine ships a benchmark harness (`@eidentic/bench`) with a deterministic
recall@k metric, a bundled synthetic dataset for CI, and loaders for the real
LongMemEval / LoCoMo datasets.

**Synthetic dataset (harness validation, runs in CI — no model needed):**

| Config | recall@8 |
|---|---:|
| Semantic (vector + embedder) | 1.00 |
| Lexical-only (BM25) | 1.00 |

This proves the recall pipeline works end-to-end, but it is **not a competitive number**: the
synthetic gold facts are verbatim substrings of ingested turns, so both retrieval paths score
perfectly by construction. See [`packages/bench/BASELINES.md`](../packages/bench/BASELINES.md)
for the dataset design and CI regression thresholds.

### Answer-accuracy numbers — pending (and why we won't fake them)

The headline memory metric in this space is **answer accuracy on LongMemEval / LoCoMo**,
LLM-judged. Producing a credible number requires:

1. the licensed datasets (gated downloads), and
2. a real model run for generation **and** for the LLM judge.

The runner is ready — see `BASELINES.md` for the exact command — but we have not funded that
run yet, and we will publish the number only when we can do so honestly and reproducibly, with
the script in this repo. We'd rather show a blank here than a number we can't stand behind —
benchmark integrity matters.

## What we deliberately do **not** claim yet

- No LongMemEval / LoCoMo answer-accuracy numbers (see above).
- No agent-task benchmark (τ-bench / SWE-bench) — Eidentic is a framework, not a tuned agent;
  a reference-agent run is future work.
- All numbers are single-machine, point-in-time (June 2026). They measure framework overhead,
  not your model or network.

Corrections and reproductions welcome via PR.
