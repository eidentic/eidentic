/**
 * hello-consolidation.ts — sleep-time memory consolidation (§6.5)
 *
 * Uses InMemoryStore (both store + graph) and MockModel scripted to return
 * a record_facts tool call. Demonstrates:
 *   1. Consolidating a short conversation into grounded KG facts.
 *   2. Querying the resulting facts via store.queryFacts.
 *   3. A second consolidation with a contradicting fact that invalidates the first.
 *
 * Run: tsx hello-consolidation.ts
 */

import { Consolidator } from "@eidentic/memory";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, type Scope } from "@eidentic/types";

const scope: Scope = { kind: "user", agentId: "consolidation-demo", userId: "baran" };

const store = new InMemoryStore();
await store.migrate();

// --- Helper: build the scripted model response for a record_facts call ---
const rec = (facts: unknown[]) => ({
  content: [toolUseBlock("c1", "record_facts", { facts })],
  usage: { inputTokens: 120, outputTokens: 45 },
});

// ============================================================
// Step 1: first consolidation — learn about the user
// ============================================================

const conversation1 =
  "User: Hi, I'm Baran. I'm a software engineer and I love TypeScript.\n" +
  "Assistant: Nice to meet you, Baran! TypeScript is a great choice.";

const model1 = new MockModel([
  rec([
    {
      subject: "Baran",
      predicate: "occupation",
      object: "software engineer",
      objectKind: "literal",
      sourceQuote: "I'm a software engineer",
    },
    {
      subject: "Baran",
      predicate: "favorite_language",
      object: "TypeScript",
      objectKind: "literal",
      sourceQuote: "I love TypeScript",
    },
  ]),
]);

const c1 = new Consolidator({
  model: model1,
  graph: store,
  now: () => "2026-01-01T00:00:00.000Z",
});

const result1 = await c1.consolidate({ scope, text: conversation1 });

console.log("=== Consolidation 1 ===");
console.log(`Asserted ${result1.facts.length} facts, dropped ${result1.dropped.length}`);
for (const f of result1.facts) {
  console.log(`  ${f.subject} ${f.predicate} ${f.object}  (source: "${f.source}")`);
}
console.log(`Usage: ${result1.usage.inputTokens} in / ${result1.usage.outputTokens} out tokens`);

// ============================================================
// Step 2: query what we know right now
// ============================================================

console.log("\n=== Current KG state ===");
const current = await store.queryFacts({ scope });
for (const f of current) {
  console.log(`  ${f.subject} ${f.predicate} ${f.object}  [valid from ${f.validFrom}]`);
}

// ============================================================
// Step 3: second consolidation — user changed their mind
// ============================================================

const conversation2 =
  "User: I've been learning Rust lately and I think it's my new favorite language.\n" +
  "Assistant: Rust is excellent for systems work!";

const model2 = new MockModel([
  rec([
    {
      subject: "Baran",
      predicate: "favorite_language",
      object: "Rust",
      objectKind: "literal",
      // sourceQuote must be a substring of conversation2
      sourceQuote: "Rust lately and I think it's my new favorite language",
    },
  ]),
]);

const c2 = new Consolidator({
  model: model2,
  graph: store,
  now: () => "2026-06-01T00:00:00.000Z",
});

const result2 = await c2.consolidate({ scope, text: conversation2 });

console.log("\n=== Consolidation 2 (contradicting fact) ===");
console.log(`Asserted ${result2.facts.length} facts, dropped ${result2.dropped.length}`);
for (const f of result2.facts) {
  console.log(`  ${f.subject} ${f.predicate} ${f.object}`);
}

// ============================================================
// Step 4: currently-valid facts (TypeScript should be gone)
// ============================================================

console.log("\n=== Currently-valid facts (after contradiction) ===");
const afterUpdate = await store.queryFacts({ scope });
for (const f of afterUpdate) {
  console.log(`  ${f.subject} ${f.predicate} ${f.object}  [valid from ${f.validFrom}]`);
}

// ============================================================
// Step 5: full history (both valid + invalidated)
// ============================================================

console.log("\n=== Full fact history (includeInvalidated: true) ===");
const history = await store.queryFacts({ scope, includeInvalidated: true });
for (const f of history) {
  const until = f.validUntil ? `→ ${f.validUntil}` : "→ now";
  console.log(`  ${f.subject} ${f.predicate} ${f.object}  [${f.validFrom} ${until}]`);
}
