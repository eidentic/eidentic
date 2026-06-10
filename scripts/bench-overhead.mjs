/**
 * Framework-overhead micro-benchmark for Eidentic core.
 *
 * Measures what Eidentic *adds* per agent turn — independent of model latency — by
 * driving a MockModel (instant response) over an in-memory store. Each query is a
 * fresh single-turn run, so the number is "cost of one isolated agent turn":
 * event-sourcing, store writes, the ReAct loop, cost preflight, compaction gate,
 * and OTel span plumbing. Reports import cost, mean/p50/p95 per-turn, throughput.
 *
 * Runs on Node, Bun, and Deno (--allow-read --allow-env). Prints one JSON line.
 *
 * Usage:  node scripts/bench-overhead.mjs [iterations]
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const runtime =
  typeof globalThis.Bun !== "undefined"
    ? "bun"
    : typeof globalThis.Deno !== "undefined"
    ? "deno"
    : "node";

const ITER = Number(process.argv[2] ?? 1000);
const WARMUP = Math.min(100, Math.floor(ITER / 5));

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000;

// --- Timed cold import of the built dist ---
const t0 = now();
const { Agent } = await import(join(root, "packages/core/dist/index.js"));
const { textBlock } = await import(join(root, "packages/types/dist/index.js"));
const { InMemoryStore, MockModel } = await import(join(root, "packages/types/dist/testing.js"));
const importMs = now() - t0;

// --- Each turn: a fresh agent + store run one single-turn query from scratch ---
// MockModel replies instantly (model latency ≈ 0), so the time is pure framework cost:
// agent construction, session creation, the ReAct loop, event-sourcing, cost preflight,
// compaction gate, and OTel plumbing. A fresh store per turn keeps history depth constant
// (avoiding the test double's O(n) append scan) and mirrors a serverless/edge cold turn.
async function oneTurn(i) {
  const store = new InMemoryStore();
  await store.migrate();
  const agent = new Agent({
    id: "bench",
    instructions: "bench agent",
    model: new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 8, outputTokens: 2 } }]),
    store,
  });
  let last;
  for await (const ev of agent.query("ping", { sessionId: `b-${i}` })) last = ev;
  if (!last || last.subtype !== "success") {
    console.error("bench FAILED at iter", i, last);
    process.exit(1);
  }
}

// Warmup (stabilise JIT) — not measured
for (let i = 0; i < WARMUP; i++) await oneTurn(`w${i}`);

// Measured: time each turn individually for percentiles
const samples = new Float64Array(ITER);
const tStart = now();
for (let i = 0; i < ITER; i++) {
  const s = now();
  await oneTurn(i);
  samples[i] = now() - s;
}
const totalMs = now() - tStart;

const sorted = Array.from(samples).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const mean = totalMs / ITER;

const out = {
  runtime,
  iterations: ITER,
  importMs: Number(importMs.toFixed(2)),
  perTurnMeanMs: Number(mean.toFixed(4)),
  perTurnP50Ms: Number(pct(50).toFixed(4)),
  perTurnP95Ms: Number(pct(95).toFixed(4)),
  throughputTurnsPerSec: Number((1000 / mean).toFixed(0)),
};
console.log(JSON.stringify(out));
process.exit(0);
