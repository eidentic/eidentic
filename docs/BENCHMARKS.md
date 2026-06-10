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

### LoCoMo answer accuracy — first official run (June 2026)

[LoCoMo](https://github.com/snap-research/locomo) (Snap Research, CC BY-NC 4.0) evaluates
long-term conversational memory: 10 multi-session conversations, 1,986 QA pairs. Following
the dataset's established scoring practice, the primary metric J(1–4) covers the 1,540
non-adversarial questions; category 5 (adversarial/unanswerable) is reported separately as a
refusal rate. Both rows below were produced by the same script in this repo
(`examples/bench-locomo.ts`), same models, same judge, same seed — full run, no sampling.

| Mode | Multi-hop | Temporal | Open-domain | Single-hop | **J(1–4)** | Cat5 refusal | Tokens/query |
|---|---|---|---|---|---|---|---|
| Full-context baseline | **46.8%** | 31.2% | 28.1% | **81.9%** | **61.6%** | 69.5% | 19,030 |
| Eidentic memory | 30.5% | **43.3%** | 28.1% | 68.5% | 53.8% | **85.2%** | **893** |

What the numbers say, honestly:

- **Temporal reasoning: memory beats full-context by +12.1 points** (43.3% vs 31.2%). The
  temporal knowledge graph and date-anchored ingestion answer "when did X happen?" questions
  that get lost in a 19k-token context window.
- **Adversarial robustness: 85.2% vs 69.5% refusal rate** — retrieval-grounded answers
  hallucinate less on unanswerable questions.
- **Token cost: 893 vs 19,030 tokens per query (95.3% less).** At production volume this is
  the difference between a viable feature and an invoice problem.
- **Where full-context wins:** single-hop and multi-hop recall (retrieval misses evidence
  that brute-force context inclusion catches). Overall J(1–4) is 7.8 points behind the
  baseline. We publish that gap rather than hide it; closing it is roadmap work, and the
  full-context baseline is exactly the bar every memory system should be measured against.

**Configuration (full disclosure):** answer + judge model `gpt-4o-mini`, embedder
`text-embedding-3-small`, topK 10, seed 42, single run, dataset SHA `3eb6f2c5`. The judge is
strict (vague/topical-only answers score as wrong) but gpt-4o-mini judges are known to be
lenient relative to humans; treat absolute numbers as comparable within this table, not
across differently-judged tables elsewhere. Raw per-question outputs contain dataset content
(CC BY-NC) and are not redistributed. Reproduce with the command in
[`packages/bench/BASELINES.md`](../packages/bench/BASELINES.md).

### LongMemEval — pending

The LongMemEval runner ships in `@eidentic/bench`; we will publish numbers when we can run it
with the same standards (full disclosure, full-context baseline, reproducible script). We'd
rather show a blank than a number we can't stand behind.

## What we deliberately do **not** claim yet

- No LongMemEval answer-accuracy numbers yet (see above).
- No agent-task benchmark (τ-bench / SWE-bench) — Eidentic is a framework, not a tuned agent;
  a reference-agent run is future work.
- All numbers are single-machine, point-in-time (June 2026). They measure framework overhead,
  not your model or network.

Corrections and reproductions welcome via PR.
