/**
 * hello-memory-completion.ts — passive extraction (§6.8) + block health (§6.5)
 *
 * Infra-free: InMemoryStore is used as both StorePort and GraphPort.
 * Demonstrates:
 *   1. Ingesting sentences with extraction:"hybrid" to passively extract facts.
 *   2. Querying the extracted facts via store.queryFacts.
 *   3. Reporting block health (fill ratio, empty required blocks, synthetic entries).
 *
 * Run: tsx hello-memory-completion.ts
 */

import { Memory, passiveExtract } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";

const store = new InMemoryStore();
await store.migrate();

const scope: Scope = { kind: "user", agentId: "completion-demo", userId: "baran" };

const memory = new Memory({
  store,
  graph: store,
  extraction: "hybrid",
  blocks: {
    human: { value: "", description: "facts about the user", limit: 200 },
    persona: { value: "I am a helpful assistant.", readOnly: true },
  },
  requiredBlocks: ["human", "goals"],
});

// ============================================================
// Step 1: Ingest some sentences — passive extraction fires
// ============================================================

console.log("=== Ingesting events with extraction:hybrid ===\n");

await memory.ingest([
  {
    id: "ev1",
    scope,
    text: "My name is Baran and I love TypeScript.",
  },
  {
    id: "ev2",
    scope,
    text: "I work at Eidentic as a software engineer.",
  },
]);

// ============================================================
// Step 2: What did passive extraction pull out?
// ============================================================

console.log("=== Passively-extracted facts (direct passiveExtract preview) ===");
const preview1 = passiveExtract("My name is Baran and I love TypeScript.");
const preview2 = passiveExtract("I work at Eidentic as a software engineer.");
for (const f of [...preview1, ...preview2]) {
  console.log(`  (${f.subject}, ${f.predicate}, ${f.object})`);
}

// ============================================================
// Step 3: Query facts from the graph (asserted during ingest)
// ============================================================

console.log("\n=== Facts in the knowledge graph (via store.queryFacts) ===");
const facts = await store.queryFacts({ scope });
for (const f of facts) {
  console.log(
    `  ${f.subject}  --[${f.predicate}]-->  "${f.object}"` +
    `  confidence=${f.confidence}  source=${f.source ?? "-"}`,
  );
}

// ============================================================
// Step 4: Block health report
// ============================================================

console.log("\n=== Block health report ===");
const health = await memory.blockHealth(scope);
for (const b of health) {
  const fill = b.fillRatio !== undefined ? `${(b.fillRatio * 100).toFixed(0)}% full` : "no limit";
  const flags = [
    b.isEmpty ? "EMPTY" : `${b.length} chars`,
    fill,
    b.required ? "REQUIRED" : "optional",
  ].join(" | ");
  console.log(`  [${b.label}]  ${flags}`);
}
