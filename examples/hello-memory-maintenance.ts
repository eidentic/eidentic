/**
 * hello-memory-maintenance.ts — memory maintenance ops demo (§6.5)
 *
 * Demonstrates:
 *   1. TTL fact invalidation via sweepExpiredFacts
 *   2. Archival dedup/merge via deduplicateArchival
 *   3. Aggregated maintenance pass via ConsolidationScheduler
 *
 * Run: npx tsx examples/hello-memory-maintenance.ts
 */

import { Memory, Consolidator, ConsolidationScheduler } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, scopeKey, type Scope } from "@eidentic/types";

// ============================================================
// Setup
// ============================================================

const scope: Scope = { kind: "user", agentId: "maintenance-demo", userId: "baran" };
const store = new InMemoryStore();
const vector = new InMemoryVectorStore();
const embedder = new FakeEmbedder(16);

const memory = new Memory({ store, graph: store, vector, embedder });

// ============================================================
// Step 1: TTL — assert facts, sweep expired ones
// ============================================================

console.log("=== Step 1: TTL — assert and sweep expired facts ===\n");

const T0 = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z"; // T0 + 1h >> 60s TTL

// TTL'd session token (expires after 60 seconds)
await store.assertFact(scope, {
  subject: "Session",
  predicate: "token",
  object: "abc123",
  validFrom: T0,
  ttlMs: 60_000,
});

// Permanent user fact (no TTL)
await store.assertFact(scope, {
  subject: "User",
  predicate: "name",
  object: "Baran",
  validFrom: T0,
});

console.log("Currently-valid facts (before sweep):");
const beforeSweep = await store.queryFacts({ scope });
for (const f of beforeSweep) {
  const ttlNote = f.expiresAt ? ` [expires ${f.expiresAt}]` : "";
  console.log(`  ${f.subject} ${f.predicate} ${f.object}${ttlNote}`);
}

const swept = await memory.sweepExpiredFacts(scope, LATER);
console.log(`\nsweepExpiredFacts(LATER) → invalidated ${swept} fact(s)`);

console.log("\nCurrently-valid facts (after sweep):");
const afterSweep = await store.queryFacts({ scope });
for (const f of afterSweep) {
  console.log(`  ${f.subject} ${f.predicate} ${f.object}`);
}

console.log("\nAll facts including invalidated (includeInvalidated: true):");
const allFacts = await store.queryFacts({ scope, includeInvalidated: true });
for (const f of allFacts) {
  const until = f.validUntil ? ` → validUntil ${f.validUntil}` : " → currently valid";
  console.log(`  ${f.subject} ${f.predicate} ${f.object}${until}`);
}

// ============================================================
// Step 2: Dedup — ingest near-identical passages, merge them
// ============================================================

console.log("\n=== Step 2: Dedup — archival passage merge ===\n");

await memory.ingest([
  { scope, id: "p1", text: "Baran prefers dark mode in all editors" },
  { scope, id: "p2", text: "Baran prefers dark mode in all editors" }, // near-identical
]);

// Demo-only: list the vector store directly using the internal accessor.
// In production code, use VectorPort.list (when your adapter supports it).
const sk = scopeKey(scope);
const beforeDedup = await vector.list(sk);
console.log(`Archived passage count (before dedup): ${beforeDedup.length}`);

const mergeModel = new MockModel([
  {
    content: [toolUseBlock("m1", "merge_passages", { passage: "Baran prefers dark mode in all editors (merged canonical)" })],
    usage: { inputTokens: 80, outputTokens: 20 },
  },
]);

const dedupeResult = await memory.deduplicateArchival(scope, { threshold: 0.95, mergeModel });
console.log(`Merged: ${dedupeResult.merged}, usage: ${dedupeResult.usage.inputTokens}in/${dedupeResult.usage.outputTokens}out`);

const afterDedup = await vector.list(sk);
console.log(`Archived passage count (after dedup): ${afterDedup.length}`);
if (afterDedup[0]) {
  console.log(`Canonical passage text: "${afterDedup[0].text}"`);
}

// ============================================================
// Step 3: Scheduler — full maintenance pass
// ============================================================

console.log("\n=== Step 3: Scheduler — full maintenance pass ===\n");

// Fresh scope for the scheduler demo (so we have a clean state to sweep/dedup)
const schedScope: Scope = { kind: "agent", agentId: "sched-demo" };

// Seed a TTL'd fact for the sweep to catch
await store.assertFact(schedScope, {
  subject: "Cache",
  predicate: "entry",
  object: "stale-key",
  validFrom: "2026-01-01T00:00:00.000Z",
  ttlMs: 1_000, // expires 1 second after validFrom
});

// Seed two near-identical passages for the dedup
await memory.ingest([
  { scope: schedScope, id: "s1", text: "The agent uses TypeScript for all tooling" },
  { scope: schedScope, id: "s2", text: "The agent uses TypeScript for all tooling" },
]);

// Source text for the distillation consolidator (must be non-empty to trigger the model call)
const SRC = "The user likes TypeScript and works as an engineer.";

const distModel = new MockModel([
  {
    content: [toolUseBlock("c1", "record_facts", { facts: [] })],
    usage: { inputTokens: 50, outputTokens: 10 },
  },
]);

const mergeModel2 = new MockModel([
  {
    content: [toolUseBlock("m2", "merge_passages", { passage: "The agent uses TypeScript for all tooling (canonical)" })],
    usage: { inputTokens: 60, outputTokens: 15 },
  },
]);

const consolidator = new Consolidator({ model: distModel, graph: store });

const scheduler = new ConsolidationScheduler({
  consolidator,
  memory,
  text: SRC,
  dedupe: { threshold: 0.95, mergeModel: mergeModel2 },
  now: () => LATER,
});

const result = await scheduler.runNow(schedScope);

console.log(`swept: ${result.swept}`);
console.log(`merged: ${result.merged}`);
console.log(`usage: ${result.usage.inputTokens}in/${result.usage.outputTokens}out tokens`);
console.log(`distillation facts: ${result.distillation.facts.length}`);
